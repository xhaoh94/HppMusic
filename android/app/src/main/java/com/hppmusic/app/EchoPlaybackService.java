package com.hppmusic.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.MediaStyleNotificationHelper;

import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Media3 后台播放服务。
 *
 * ExoPlayer 负责音频焦点、音频输出和 becoming-noisy（耳机拔出）处理，
 * MediaSession 负责把播放状态暴露给系统媒体控件。
 *
 * ── 前台服务与通知：为什么自己实现 ──
 *
 * 原来依赖 Media3 的 `MediaSessionService` 自动启动前台服务 + 发播放通知，
 * 实测在本项目里**根本没触发**（`dumpsys activity services` 里
 * `startForegroundCount=0`，通知栏也没有任何东西）。
 *
 * 后果比"没有通知"严重得多：播放期间服务一直只是个**普通后台服务**
 * （虽然 `startRequested=true`，但没有前台优先级），系统可以随时回收它。
 * 一旦回收，`onDestroy` 把 `player` 置 null，而插件手里缓存的 service 引用
 * 仍然非空 —— 下一次 `load()` 就对着 null player 调 `setMediaItem`，
 * **整个应用直接闪退**（崩溃栈：
 * `EchoPlaybackService.lambda$load$2 ... NullPointerException`）。
 *
 * 所以这里自己维护前台服务与通知：
 * · 播放时 `startForeground`（带 mediaPlayback 类型）→ 不再被系统回收
 * · 通知用 `MediaStyleNotificationHelper.MediaStyle(mediaSession)`，
 *   锁屏/耳机/系统媒体控制全部接上（这顺带修了
 *   `MediaSessionCompat: Couldn't find a unique registered media button receiver`）
 * · 暂停时**保持前台**（音乐应用的标准行为：用户随时可能继续播，
 *   退了前台就会被回收，通知也会被清掉）
 * · `stop` / `onDestroy` 才 `stopForeground(true)` 并移除通知
 *
 * 通知按钮不依赖 Media3 的 ActionFactory，而是自己发 action intent 给
 * `onStartCommand` —— 少一层间接，且行为完全可控。
 */
@UnstableApi
public final class EchoPlaybackService extends MediaSessionService {
    /** DSP 参数诊断：设置页能拖但声音不变时，用 `adb logcat -s EchoDsp` 就能分清是没下发还是没生效。 */
    private static final String DSP_TAG = "EchoDsp";

    private static final String TAG = "EchoPlayback";
    private static final String CHANNEL_ID = "hppmusic_playback";
    private static final int NOTIFICATION_ID = 1001;
    /** 通知按钮的 action；由 onStartCommand 消费 */
    public static final String ACTION_PLAY_PAUSE = "com.hppmusic.app.action.PLAY_PAUSE";
    public static final String ACTION_NEXT = "com.hppmusic.app.action.NEXT";
    public static final String ACTION_PREVIOUS = "com.hppmusic.app.action.PREVIOUS";
    public static final String ACTION_STOP = "com.hppmusic.app.action.STOP";
    public interface Listener {
        void onTimeUpdate(double time, long sampledAt, int trackSeq, int generation);
        void onDurationChange(double duration, int trackSeq, int generation);
        void onSeeked(double time, long sampledAt, int trackSeq, int generation);
        void onSeekStateChange(boolean active, double time, long sampledAt, int trackSeq, int generation);
        void onStateChange(boolean playing, boolean paused, double time, long sampledAt,
                           int trackSeq, int generation);
        void onPlaybackEnd(String reason, long sampledAt, int trackSeq, int generation);
        void onFileLoaded(String url, double duration, int seq, long sampledAt, int generation);
        void onError(String message, String errorCode, String reason,
                     long sampledAt, int trackSeq, int generation);
        void onMediaControl(String type, @Nullable Double position, @Nullable Double offset);
    }

    public static final int LOAD_TIMEOUT_MS = 15_000;
    private static final int POSITION_UPDATE_MS = 250;
    private static volatile EchoPlaybackService instance;

    private final IBinder binder = new LocalBinder();
    private final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private EchoDspAudioProcessor dspProcessor;
    private MediaSession mediaSession;
    private PendingLoad pendingLoad;
    /** 是否已经进了前台；stopForeground 只能对有过的状态调，否则会抛。 */
    private boolean foregroundStarted;
    /**
     * 待下发给 MediaItem 的媒体元数据（通知/锁屏的歌名、歌手、封面）。
     *
     * 渲染层的调用时序是「先 updateMediaMetadata，后 setSource→load」：若像以前那样
     * 只 replaceMediaItem 当前项，元数据会落在上一个曲目的 item 上、随即被
     * beginSourceChange 的 clearMediaItems 丢弃，新 item 是裸的 —— 通知里就没有歌名。
     * 所以这里先暂存，load() 建 item 时一并带上；已停在某曲目时（封面延迟到达）仍
     * 立即替换当前项。
     */
    private MediaMetadata pendingMetadata;
    private int requestSeq;
    private int sourceSeq;
    private int generation;
    private boolean destroyed;

    private final Runnable positionTicker = new Runnable() {
        @Override
        public void run() {
            if (destroyed) return;
            if (player != null && player.isPlaying()) {
                emitTimeUpdate();
            }
            mainHandler.postDelayed(this, POSITION_UPDATE_MS);
        }
    };

    public static EchoPlaybackService getInstance() {
        return instance;
    }

    /**
     * 服务是否已被销毁。
     *
     * 插件侧必须先问这个再决定要不要复用缓存的实例：播放停止后 Media3 会放弃
     * 前台服务状态，系统可以随时回收它（`onDestroy` 里 `player` 被置 null），
     * 而插件手里的引用仍然非空 —— 旧实现就因此在对已销毁的服务下发 `load()` 时
     * 抛 NPE，直接导致整个应用闪退。
     */
    public boolean isDestroyed() {
        return destroyed;
    }

    /**
     * 播放器是否可用。
     *
     * `onDestroy` 会把 player 置 null，这之后任何对 player 的访问都必须先过这道门。
     * 注意 `command(...)` 内部已有 try/catch，真正危险的是**不走 command 的裸调用**
     * （`load()` 与 `getState()`）—— 它们就是之前崩溃的位置。
     */
    private boolean isPlayerReady() {
        return !destroyed && player != null;
    }

    /** 是否正在出声（决定媒体按键里的 PLAY_PAUSE 该发 Play 还是 Pause） */
    private boolean isPlayerPlaying() {
        return isPlayerReady() && player.isPlaying();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();

        dspProcessor = new EchoDspAudioProcessor();
        EchoDspRenderersFactory renderersFactory = new EchoDspRenderersFactory(this, dspProcessor);
        player = new ExoPlayer.Builder(this, renderersFactory).build();
        // 第二个参数让 Media3 自动申请/释放音频焦点。
        player.setAudioAttributes(audioAttributes, true);
        // Media3 在 AUDIO_BECOMING_NOISY（通常是耳机拔出）时暂停。
        player.setHandleAudioBecomingNoisy(true);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_READY) {
                    completePendingLoadIfReady();
                } else if (playbackState == Player.STATE_ENDED) {
                    emitPlaybackEnd("eof");
                    emitState();
                }
                emitState();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                // 播放状态变了就刷通知（否则按钮图标会停在旧状态）
                updatePlaybackNotification();
                emitState();
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo oldPosition,
                                                  Player.PositionInfo newPosition,
                                                  int reason) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) {
                    double position = seconds(player.getCurrentPosition());
                    long now = System.currentTimeMillis();
                    for (Listener listener : listeners) {
                        listener.onSeekStateChange(false, position, now, sourceSeq, generation);
                        listener.onSeeked(position, now, sourceSeq, generation);
                    }
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String message = error.getMessage();
                if (message == null || message.isEmpty()) message = "音频播放失败";
                failPendingLoad(message, "media3-playback", "media3");
                long now = System.currentTimeMillis();
                for (Listener listener : listeners) {
                    listener.onError(message, "media3-playback", "media3", now, sourceSeq, generation);
                }
            }
        });

        mediaSession = new MediaSession.Builder(this, player)
                .setId("HppMusic")
                .setCallback(new MediaSession.Callback() {
                    /**
                     * 蓝牙耳机 / 车机 / 有线线控的媒体按键。
                     *
                     * ⚠️ 这些按键以 `MEDIA_BUTTON` 广播进 `MediaButtonReceiver`
                     * （manifest 里必须显式声明，否则系统那句
                     * `Couldn't find a unique registered media button receiver`
                     * 会一直存在、按键静默失效），再送到这里。
                     *
                     * Media3 默认会把按键翻译成 player 的命令，而本项目的 player 里
                     * 始终只有一个 MediaItem（队列/随机/单循环/失败跳过都在渲染层），
                     * 原生 seek 下一首无从下手 —— 所以按本类既有的约定转成
                     * onMediaControl 事件交回渲染层，类型名与内核的
                     * setMediaSessionHandlers 逐字对齐。
                     */
                    @SuppressWarnings("deprecation")
                    @Override
                    public boolean onMediaButtonEvent(
                            @NonNull MediaSession session,
                            @NonNull MediaSession.ControllerInfo controllerInfo,
                            @NonNull Intent mediaButtonIntent) {
                        if (!Intent.ACTION_MEDIA_BUTTON.equals(mediaButtonIntent.getAction())) {
                            return false;
                        }
                        KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                        // 只认按下：重复的 ACTION_UP 会让一次点击切两首
                        if (event == null || event.getAction() != KeyEvent.ACTION_DOWN) return false;

                        String type;
                        switch (event.getKeyCode()) {
                            case KeyEvent.KEYCODE_MEDIA_NEXT:
                                type = "NextSong";
                                break;
                            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                                type = "PreviousSong";
                                break;
                            case KeyEvent.KEYCODE_MEDIA_PLAY:
                                type = "Play";
                                break;
                            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                            case KeyEvent.KEYCODE_MEDIA_STOP:
                                type = "Pause";
                                break;
                            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                                type = isPlayerPlaying() ? "Pause" : "Play";
                                break;
                            default:
                                return false;
                        }
                        emitMediaControl(type);
                        return true;
                    }
                })
                .build();
        createNotificationChannel();
        mainHandler.post(positionTicker);
    }

    // ────────────────────────────────────────────────────
    // 前台服务与播放通知
    //
    // 存在的理由见类注释：不自己维持前台服务的话，service 会被系统回收，
    // 而插件手里缓存的引用仍非空 —— 下次 load 就 NPE 闪退。
    // ────────────────────────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "播放控制",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示当前播放的歌曲与播放控制");
        // 音乐通知不该震/响，也不该在锁屏上被折叠成静默
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
    }

    private PendingIntent notificationAction(String action, int requestCode) {
        Intent intent = new Intent(this, EchoPlaybackService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildPlaybackNotification() {
        boolean playing = isPlayerReady() && player.isPlaying();

        MediaMetadata metadata = isPlayerReady() ? player.getMediaMetadata() : pendingMetadata;
        CharSequence title = metadata != null ? metadata.title : null;
        CharSequence artist = metadata != null ? metadata.artist : null;
        if (title == null || title.length() == 0) title = "未在播放";
        if (artist == null) artist = "";

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification_playback)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(contentIntent)
                // 播放中不可划掉（否则通知没了但音乐还在响，用户找不到入口）
                .setOngoing(playing)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_media_previous, "上一首",
                        notificationAction(ACTION_PREVIOUS, 1))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "暂停" : "播放",
                        notificationAction(ACTION_PLAY_PAUSE, 2))
                .addAction(android.R.drawable.ic_media_next, "下一首",
                        notificationAction(ACTION_NEXT, 3));

        // MediaStyle 把通知与 MediaSession 绑起来：锁屏控制、蓝牙耳机按键、
        // 系统的"正在播放"面板都靠它。mediaSession 为 null 时略过（早期启动阶段）。
        if (mediaSession != null) {
            builder.setStyle(new MediaStyleNotificationHelper.MediaStyle(mediaSession)
                    .setShowActionsInCompactView(0, 1, 2));
        }

        return builder.build();
    }

    /** 进入前台（播放开始时调）。幂等：已在后台运行时只是刷一次通知内容。 */
    private void startPlaybackForeground() {
        if (destroyed) return;
        try {
            Notification notification = buildPlaybackNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            foregroundStarted = true;
        } catch (Throwable error) {
            // 前台服务被系统拒绝（例如后台启动限制）时不能把播放一起搞挂：
            // 退化成"只有普通服务"，至少还能响。
            Log.w(TAG, "startForeground 失败，本次播放没有前台优先级", error);
        }
    }

    /** 刷新通知内容（元数据/播放状态变化时调）。未在前台时不做事。 */
    private void updatePlaybackNotification() {
        if (destroyed || !foregroundStarted) return;
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildPlaybackNotification());
        } catch (Throwable error) {
            Log.w(TAG, "更新播放通知失败", error);
        }
    }

    /** 退出前台并移除通知（停止播放/服务销毁时调）。 */
    private void stopPlaybackForeground() {
        if (!foregroundStarted) return;
        foregroundStarted = false;
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Throwable error) {
            Log.w(TAG, "stopForeground 失败", error);
        }
    }

    /**
     * 通知按钮的落点。
     *
     * 用自定义 action 而不是复用系统媒体按钮广播：同一进程内的自控制
     * 少一层权限/注册要求，行为完全可控（且不依赖已废弃的
     * `MediaButtonReceiver`）。
     */
    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action != null && isPlayerReady()) {
            switch (action) {
                case ACTION_PLAY_PAUSE:
                    if (player.isPlaying()) player.pause(); else player.play();
                    break;
                case ACTION_NEXT:
                    // 顺序/随机等模式由渲染层决定，这里只上报"用户点了下一首"
                    emitMediaControl("NextSong");
                    break;
                case ACTION_PREVIOUS:
                    emitMediaControl("PreviousSong");
                    break;
                case ACTION_STOP:
                    player.stop();
                    player.clearMediaItems();
                    stopPlaybackForeground();
                    break;
                default:
                    break;
            }
            updatePlaybackNotification();
        }
        return super.onStartCommand(intent, flags, startId);
    }

    /**
     * 把"用户点了通知上的按钮"转成渲染层能处理的事件。
     *
     * ⚠️ 事件名必须与内核的映射表**逐字一致**（`src/renderer/utils/player.ts`
     * 的 `setMediaSessionHandlers`）：它认的是 PascalCase 的
     * `NextSong` / `PreviousSong` / `Play` / `Pause` / `Seek*`。
     * 写成 lowercase（如 `nexttrack`，那是 Android `MediaSession` 自己的叫法）
     * 会静静地不匹配，表现为：通知上的按钮点下去没任何反应且不报错。
     *
     * ⚠️ 为什么"下一首/上一首"不直接在这里调 player：
     * 曲目顺序由渲染层的队列决定（随机/单循环/失败跳过、私人 FM、一起听……）。
     * 原生侧只知道播放器里当前那一个 MediaItem，直接 seek 下一首
     * 会绕开队列与播放模式，与界面显示的顺序不一致。
     */
    private void emitMediaControl(String type) {
        for (Listener listener : listeners) {
            listener.onMediaControl(type, null, null);
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 音频播放服务应在应用界面被移除后继续工作；由系统媒体会话控制生命周期。
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        IBinder serviceBinder = super.onBind(intent);
        // MediaSessionService 需要返回自己的 MediaSession binder；插件使用显式 local bind。
        return serviceBinder != null ? serviceBinder : binder;
    }

    public final class LocalBinder extends Binder {
        EchoPlaybackService getService() {
            return EchoPlaybackService.this;
        }
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    public CompletableFuture<Integer> beginSourceChange() {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        runOnMain(() -> {
            generation++;
            requestSeq++;
            cancelPendingLoad("Audio source load was superseded");
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            emitState();
            future.complete(requestSeq);
        });
        return future;
    }

    public CompletableFuture<LoadResult> load(String url, int requestedRequestSeq) {
        CompletableFuture<LoadResult> future = new CompletableFuture<>();
        runOnMain(() -> {
            // ⚠️ 判空必须在 lambda 内部：player 可能在 post 之后、执行之前被释放。
            if (!isPlayerReady()) {
                future.completeExceptionally(
                        new IllegalStateException("播放服务已释放，请重试"));
                return;
            }
            if (url == null || url.trim().isEmpty()) {
                future.completeExceptionally(new IllegalArgumentException("音频地址为空"));
                return;
            }
            if (requestedRequestSeq >= 0 && requestedRequestSeq != requestSeq) {
                future.completeExceptionally(new IllegalStateException("Audio source load was superseded"));
                return;
            }
            cancelPendingLoad("Audio source load was superseded");
            int seq = ++sourceSeq;
            int loadGeneration = generation;
            MediaItem.Builder builder = new MediaItem.Builder()
                    .setMediaId("hppmusic-" + seq)
                    .setUri(Uri.parse(url));
            // 带上最近一次 updateMediaMetadata 的暂存值：通知从首帧起就有歌名/歌手。
            // 不随 load 清空 —— 切音质（无元数据下发的换源）时靠它保持当前曲目信息。
            if (pendingMetadata != null) builder.setMediaMetadata(pendingMetadata);
            MediaItem item = builder.build();
            try {
                pendingLoad = new PendingLoad(future, requestedRequestSeq, loadGeneration, seq, url);
                player.setMediaItem(item);
                player.prepare();
            } catch (Throwable error) {
                // setMediaItem 之后才可能抛：必须把 pendingLoad 清掉，否则残留的
                // 失败记录会让后续的完成回调异常
                pendingLoad = null;
                future.completeExceptionally(error);
                return;
            }
            mainHandler.postDelayed(() -> {
                if (pendingLoad != null && pendingLoad.future == future) {
                    failPendingLoad("音频加载超时", "load-timeout", "timeout");
                }
            }, LOAD_TIMEOUT_MS);
        });
        return future;
    }

    public CompletableFuture<Void> play(int requestedRequestSeq) {
        return command(() -> {
            checkRequest(requestedRequestSeq);
            player.play();
            // 播放开始就进前台：这是"不被系统回收"的唯一保障，
            // 而 service 一旦被回收，下一次 load 就会因为 player 为 null 而崩溃。
            startPlaybackForeground();
            updatePlaybackNotification();
        });
    }

    public CompletableFuture<Void> pause() {
        return command(() -> {
            player.pause();
            // 暂停后**保持前台**（只刷新通知）：音乐应用里用户随时可能继续播，
            // 退了前台就会被系统回收，通知也被清掉、下次切歌直接崩。
            // 真正的退出前台在 stop() / onDestroy。
            startPlaybackForeground();
            updatePlaybackNotification();
        });
    }

    public CompletableFuture<Void> stop() {
        return command(() -> {
            player.stop();
            player.clearMediaItems();
            stopPlaybackForeground();
            emitState();
        });
    }

    public CompletableFuture<Void> seek(double time) {
        return command(() -> {
            if (!Double.isFinite(time)) throw new IllegalArgumentException("seek 时间无效");
            double target = Math.max(0, time);
            long now = System.currentTimeMillis();
            for (Listener listener : listeners) {
                listener.onSeekStateChange(true, target, now, sourceSeq, generation);
            }
            player.seekTo(Math.round(target * 1000.0));
        });
    }

    public CompletableFuture<Void> setVolume(double volume) {
        return command(() -> player.setVolume((float) Math.max(0, Math.min(1, volume / 100.0))));
    }

    public CompletableFuture<Void> setSpeed(double speed) {
        return command(() -> {
            if (!Double.isFinite(speed) || speed <= 0) throw new IllegalArgumentException("播放速度无效");
            player.setPlaybackSpeed((float) Math.max(0.1, Math.min(5.0, speed)));
        });
    }

    public CompletableFuture<Void> setLoopFile(boolean loop) {
        return command(() -> player.setRepeatMode(loop ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF));
    }

    public CompletableFuture<Void> setPauseOnDeviceDisconnect(boolean enabled) {
        return command(() -> player.setHandleAudioBecomingNoisy(enabled));
    }

    public CompletableFuture<Bundle> getState() {
        CompletableFuture<Bundle> future = new CompletableFuture<>();
        runOnMain(() -> {
            Bundle state = new Bundle();
            /**
             * 服务已释放时返回“空状态”而不是抛异常。
             *
             * 这个方法是渲染层定时轮询的，抛异常会在 JS 侧变成未处理的 rejection
             * （内核的 getState 调用点没有 catch），而“全 0 + 未播放”在语义上
             * 就等于“没有在放任何东西”，是安全的降级。
             */
            if (!isPlayerReady()) {
                state.putBoolean("playing", false);
                state.putBoolean("paused", true);
                state.putDouble("duration", 0);
                state.putDouble("timePos", 0);
                state.putDouble("volume", 0);
                state.putDouble("speed", 1);
                state.putInt("trackSeq", sourceSeq);
                state.putInt("generation", generation);
                state.putLong("sampledAt", System.currentTimeMillis());
                future.complete(state);
                return;
            }
            try {
                state.putBoolean("playing", player.isPlaying());
                state.putBoolean("paused", !player.isPlaying());
                state.putDouble("duration", seconds(player.getDuration()));
                state.putDouble("timePos", seconds(player.getCurrentPosition()));
                state.putDouble("volume", player.getVolume() * 100.0);
                state.putDouble("speed", player.getPlaybackParameters().speed);
                state.putInt("trackSeq", sourceSeq);
                state.putInt("generation", generation);
                state.putLong("sampledAt", System.currentTimeMillis());
                future.complete(state);
            } catch (Throwable error) {
                future.completeExceptionally(error);
            }
        });
        return future;
    }

    public CompletableFuture<Void> updateMetadata(String title, String artist, String album,
                                                   String coverUrl, long durationMs) {
        return command(() -> {
            MediaMetadata.Builder metadata = new MediaMetadata.Builder();
            if (title != null) metadata.setTitle(title);
            if (artist != null) metadata.setArtist(artist);
            if (album != null) metadata.setAlbumTitle(album);
            if (coverUrl != null && !coverUrl.isEmpty()) metadata.setArtworkUri(Uri.parse(coverUrl));
            pendingMetadata = metadata.build();
            // 已停在某曲目且没有加载在途时立即刷新当前项（封面延迟到达的场景）；
            // 否则（切歌前的调用）只暂存，由随后的 load() 带上新 item —— 提前替换
            // 会落到上一个曲目的 item 上，紧接着就被 clearMediaItems 丢掉。
            if (player.getCurrentMediaItem() != null && pendingLoad == null) {
                applyMetadataToCurrentItem(pendingMetadata);
            }
            // 元数据到达就刷通知：渲染层的时序是"先 updateMetadata，后 load"，
            // 所以这里刷到的是即将播放的那首（封面延迟到达时还会再刷一次）。
            updatePlaybackNotification();
        });
    }

    private void applyMetadataToCurrentItem(MediaMetadata metadata) {
        MediaItem current = player.getCurrentMediaItem();
        if (current == null) return;
        player.replaceMediaItem(player.getCurrentMediaItemIndex(), current.buildUpon()
                .setMediaMetadata(metadata)
                .build());
    }

    public CompletableFuture<Void> setAudioEffect(String path, double mix) {
        return setAudioEffect(path, mix, null);
    }

    /**
     * 音效设置。
     *
     * @param path         卷积音效（WAV/IRS）路径，空则关闭
     * @param mix          dry/wet 比例
     * @param centerChannel 中置声道处理："vocal" / "accompaniment" / 空则关闭。
     *                      人声/伴奏在 Android 上由本地算法实现（上游没有对应音源），
     *                      与卷积可以共存。
     */
    public CompletableFuture<Void> setAudioEffect(String path, double mix, String centerChannel) {
        if (path != null && path.toLowerCase().endsWith(".vpf")) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalArgumentException("VPF 音效需要独立 DSP Provider，当前不支持"));
            return failed;
        }
        if (dspProcessor == null) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException("音效处理器未初始化"));
            return failed;
        }
        dspProcessor.setCenterChannel(centerChannel);
        Log.i(DSP_TAG, "setAudioEffect center=" + dspProcessor.centerModeName());
        return dspProcessor.setEffect(path, (float) mix);
    }

    /** 10 段均衡器（dB，±12 范围内），由渲染层 EffectPopover 直接驱动。 */
    public CompletableFuture<Void> setEqualizer(float[] gains) {
        if (dspProcessor == null) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException("音效处理器未初始化"));
            return failed;
        }
        dspProcessor.setEqualizer(gains);
        Log.i(DSP_TAG, "setEqualizer " + java.util.Arrays.toString(dspProcessor.getEqualizerGainsDb()));
        return CompletableFuture.completedFuture(null);
    }

    /** 音量均衡（EBU R128）增益，单位 dB，由渲染层算好后下发。 */
    public CompletableFuture<Void> setNormalizationGain(double gainDb) {
        if (dspProcessor == null) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException("音效处理器未初始化"));
            return failed;
        }
        dspProcessor.setNormalizationGain(gainDb);
        Log.i(DSP_TAG, "setNormalizationGain " + dspProcessor.getNormalizationGainDb() + " dB");
        return CompletableFuture.completedFuture(null);
    }

    public CompletableFuture<Void> updateState(String status, double playbackRate) {
        // 播放状态以 ExoPlayer/MediaSession 为唯一事实来源，避免 renderer 的回报形成循环。
        return command(() -> { });
    }

    public CompletableFuture<Void> updateTimeline(double currentTimeMs, double totalTimeMs,
                                                   boolean isPlaying, double playbackRate) {
        // MediaSession 的通知时间线直接读取 ExoPlayer，renderer 的时间线仅作同步提示。
        return command(() -> { });
    }

    public CompletableFuture<Void> updateSkipIntervals(double forwardMs, double backwardMs) {
        // Media3 默认快进/快退命令由 Player 管理；这里只接受并保持 API 兼容。
        return command(() -> { });
    }

    public boolean isNotificationPermissionGranted() {
        if (android.os.Build.VERSION.SDK_INT < 33) return true;
        return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private CompletableFuture<Void> command(Runnable action) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        runOnMain(() -> {
            try {
                action.run();
                future.complete(null);
            } catch (Throwable error) {
                future.completeExceptionally(error);
            }
        });
        return future;
    }

    private void checkRequest(int requestedRequestSeq) {
        if (requestedRequestSeq >= 0 && requestedRequestSeq != requestSeq) {
            throw new IllegalStateException("Player command was superseded");
        }
    }

    private void runOnMain(Runnable runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) runnable.run();
        else mainHandler.post(runnable);
    }

    private void completePendingLoadIfReady() {
        if (pendingLoad == null || player.getPlaybackState() != Player.STATE_READY) return;
        PendingLoad load = pendingLoad;
        pendingLoad = null;
        double duration = seconds(player.getDuration());
        load.future.complete(new LoadResult(duration, load.seq));
        long now = System.currentTimeMillis();
        for (Listener listener : listeners) {
            listener.onDurationChange(duration, load.seq, load.generation);
            listener.onFileLoaded(load.url, duration, load.seq, now, load.generation);
        }
    }

    private void cancelPendingLoad(String message) {
        if (pendingLoad == null) return;
        PendingLoad load = pendingLoad;
        pendingLoad = null;
        load.future.completeExceptionally(new IllegalStateException(message));
    }

    private void failPendingLoad(String message, String code, String reason) {
        if (pendingLoad != null) {
            PendingLoad load = pendingLoad;
            pendingLoad = null;
            load.future.completeExceptionally(new IllegalStateException(message));
        }
        long now = System.currentTimeMillis();
        for (Listener listener : listeners) {
            listener.onError(message, code, reason, now, sourceSeq, generation);
        }
    }

    /**
     * 下面几个 emit* 都先判 `isPlayerReady()`。
     *
     * 当前调用点（positionTicker / listener 回调）本身已经守住了，但它们是
     * **每 250ms 跑一次**的热路径，一旦将来有人在别处调一下就变成崩溃源；
     * 而且 `player` 为 null 时返回的"空值"语义上就是"没有在播"，不会误导调用方。
     */
    private void emitTimeUpdate() {
        if (!isPlayerReady()) return;
        double time = seconds(player.getCurrentPosition());
        long now = System.currentTimeMillis();
        for (Listener listener : listeners) {
            listener.onTimeUpdate(time, now, sourceSeq, generation);
        }
    }

    private void emitDurationChange() {
        if (!isPlayerReady()) return;
        double duration = seconds(player.getDuration());
        for (Listener listener : listeners) {
            listener.onDurationChange(duration, sourceSeq, generation);
        }
    }

    private void emitState() {
        if (!isPlayerReady()) return;
        boolean playing = player.isPlaying();
        long now = System.currentTimeMillis();
        double time = seconds(player.getCurrentPosition());
        for (Listener listener : listeners) {
            listener.onStateChange(playing, !playing, time, now, sourceSeq, generation);
        }
    }

    private void emitPlaybackEnd(String reason) {
        long now = System.currentTimeMillis();
        for (Listener listener : listeners) {
            listener.onPlaybackEnd(reason, now, sourceSeq, generation);
        }
    }

    private static double seconds(long milliseconds) {
        if (milliseconds == C.TIME_UNSET || milliseconds < 0) return 0;
        return milliseconds / 1000.0;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        stopPlaybackForeground();
        mainHandler.removeCallbacks(positionTicker);
        cancelPendingLoad("Playback service destroyed");
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        dspProcessor = null;
        listeners.clear();
        instance = null;
        super.onDestroy();
    }

    public static final class LoadResult {
        public final double duration;
        public final int seq;

        LoadResult(double duration, int seq) {
            this.duration = duration;
            this.seq = seq;
        }
    }

    private static final class PendingLoad {
        final CompletableFuture<LoadResult> future;
        final int requestSeq;
        final int generation;
        final int seq;
        final String url;

        PendingLoad(CompletableFuture<LoadResult> future, int requestSeq, int generation,
                    int seq, String url) {
            this.future = future;
            this.requestSeq = requestSeq;
            this.generation = generation;
            this.seq = seq;
            this.url = url;
        }
    }
}
