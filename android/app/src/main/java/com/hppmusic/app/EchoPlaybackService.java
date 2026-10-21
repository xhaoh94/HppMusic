package com.hppmusic.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
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

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
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
    private static final String BACKGROUND_NEXT_PREFIX = "hppmusic-background-next:";
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

    // ── 音频焦点（自行管理）──
    //
    // 规则（用户要求"有其他音源真的在放才暂停"）：
    // · 永久丢失（AUDIOFOCUS_LOSS）→ 暂停 —— 对方一般是真的在放；
    // · 瞬时抢焦 / 降音量 → 忽略 —— 抖音启动时的那一下就属于这类，不出声不该打扰；
    // · 丢焦后重新拿到焦点（GAIN）→ 恢复播放；
    // · 「与其他音源同时播放」开启时干脆不申请焦点，永不暂停。
    // 耳机拔出暂停与这里无关，走 ExoPlayer 自己的 BECOMING_NOISY 开关。

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    /** 因丢焦暂停的：拿到焦点后据此恢复；用户手动暂停的不恢复 */
    private boolean focusLossPaused;
    private int focusLossCheckAttempt;
    /** 本次丢焦判定的截止时间（毫秒，uptime 基准） */
    private long focusLossCheckDeadline;
    /** 给“对方真的出声”留的观察窗口：抖音这类冷启动到建 AudioTrack 常要 1~2 秒。 */
    private static final long FOCUS_LOSS_WINDOW_MS = 2_500;
    private static final long FOCUS_LOSS_POLL_MS = 400;
    private final Runnable focusLossCheck = new Runnable() {
        @Override
        public void run() {
            if (coPlayWithOthers || !isPlayerPlaying() || focusLossPaused) return;
            if (hasExternalActivePlayback()) {
                focusLossPaused = true;
                player.pause();
                Log.i(TAG, "检测到其他应用正在输出音频，暂停本机播放");
                return;
            }
            // 焦点事件通常早于对方真正创建 AudioTrack：在观察窗口内反复短查，
            // 命中即立即暂停；静音视频没有活跃的音频播放器，永远不会命中。
            if (SystemClock.uptimeMillis() < focusLossCheckDeadline) {
                mainHandler.postDelayed(this, FOCUS_LOSS_POLL_MS);
            } else {
                Log.i(TAG, "观察窗口内未检测到其他应用音频输出，忽略本次丢焦");
            }
        }
    };
    /** 与其他音源同时播放：不申请焦点、不响应丢焦 */
    private boolean coPlayWithOthers;
    /**
     * WebView 退后台后不会可靠执行 Capacitor 的 notifyListeners。
     * 媒体按键不能直接丢掉，回到前台时由 JS 主动取走并按队列处理。
     */
    private boolean appInBackground;
    /** 当前 Media3 playlist 是否由 renderer 下发的后台队列组成。 */
    private boolean backgroundPlaylistActive;
    private int backgroundRepeatMode = -1;
    private int backgroundExpectedCount = 1;
    private final Map<String, Integer> backgroundQueueIndices = new HashMap<>();
    private String backgroundInitialMediaId = "";
    private String backgroundInitialTrackId = "";
    /**
     * 后台期间暂存的媒体按键。
     *
     * ⚠️ 必须带时间戳与“按下时的曲目序号”：车载蓝牙上连续按上下首时，
     * 偶有几下会落在原生队列还没准备完的时刻（skipNativeQueueTrack 返回 false），
     * 这些会被暂存。如果用户锁屏半小时后才回到 App，恢复时把这些**几十秒前的**
     * 按下一股脑执行，就会凭空多切几首歌（用户反馈“解锁后自动切了新歌”正是这个）。
     * 所以恢复时只执行“还新鲜、且曲目没变过”的那几条。
     */
    private final ArrayDeque<PendingControl> pendingMediaControls = new ArrayDeque<>();

    private static final class PendingControl {
        final String type;
        final long at;
        final int seq;

        PendingControl(String type, long at, int seq) {
            this.type = type;
            this.at = at;
            this.seq = seq;
        }
    }

    /** 超过这个时长的后台按键直接作废：用户早就不知道按过什么了。 */
    private static final long PENDING_CONTROL_TTL_MS = 10_000;
    private androidx.media3.common.AudioAttributes playbackAudioAttributes;

    private androidx.media3.common.AudioAttributes getPlaybackAudioAttributes() {
        if (playbackAudioAttributes == null) {
            playbackAudioAttributes = new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build();
        }
        return playbackAudioAttributes;
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        // listener 用 mainHandler 绑定（见 applyAudioFocusMode），回调已在主线程
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS: {
                // LOSS 是**永久**丢失：框架已把本应用移出焦点栈，之后不会再有 GAIN。
                // 必须无条件放弃并清空 focusRequest —— 暂停态下如果提前 return，
                // request 会一直留着重非空，applyAudioFocusMode 的“已在监听”判断会
                // 永远挡住重新申请（表现：被抢过一次焦点后，别的 App 放歌再也不暂停）。
                boolean wasPlaying = isPlayerPlaying();
                abandonAudioFocus(!wasPlaying);
                if (coPlayWithOthers || !wasPlaying) break;
                focusLossPaused = true;
                focusLossCheckAttempt = 0;
                focusLossCheckDeadline = SystemClock.uptimeMillis() + FOCUS_LOSS_WINDOW_MS;
                mainHandler.post(focusLossCheck);
                break;
            }
            case AudioManager.AUDIOFOCUS_GAIN:
                mainHandler.removeCallbacks(focusLossCheck);
                if (!focusLossPaused || !isPlayerReady()) return;
                focusLossPaused = false;
                player.play();
                break;
            default:
                // GAIN_TRANSIENT_MAY_DUCK / LOSS_TRANSIENT 等：一律忽略
                break;
        }
    };

    /** 是否走自管焦点；API 26 以下没有 AudioFocusRequest，交回 Media3 自动管理。 */
    private static boolean canManageAudioFocus() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
    }

    /** 按当前模式申请/放弃焦点；在播放真正开始时调用，避免空占焦点打扰别的应用。 */
    private void applyAudioFocusMode() {
        if (audioManager == null || !canManageAudioFocus()) return;
        try {
            if (coPlayWithOthers) {
                abandonAudioFocus(true);
                focusLossPaused = false;
                return;
            }
            // 暂停中不占用焦点：这时候申请会把正在放歌的其他应用挤停。
            if (!isPlayerPlaying()) return;
            if (focusRequest != null) return; // 已在监听
            // AudioFocusRequest 要的是平台 AudioAttributes（与 Media3 的是两个类）。
            // ⚠️ listener 必须绑：requestAudioFocus 对没有 listener 的请求会直接抛
            // IllegalStateException —— 上一版没绑，异常被吞、焦点事件从此没有回调，
            // 表现为"别的应用真在放也不暂停"。
            android.media.AudioAttributes focusAttributes =
                    new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(focusAttributes)
                    .setOnAudioFocusChangeListener(focusListener, mainHandler)
                    .build();
            int result = audioManager.requestAudioFocus(focusRequest);
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                // 被拒绝/延迟时不能把 request 留着：否则“已在监听”会永久挡住后续申请。
                Log.w(TAG, "requestAudioFocus 未获批准: " + result);
                audioManager.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            }
        } catch (Throwable error) {
            // 焦点失败绝不能打断播放（它是在 onIsPlayingChanged 里被调用的）
            Log.w(TAG, "audio focus request failed", error);
            focusRequest = null;
        }
    }

    /**
     * 音频焦点只说明“有人申请了媒体焦点”，不能说明对方真的有声音。
     * Android N+ 可以读取活跃的 AudioTrack 播放配置；排除本进程后，只有存在
     * 已启动的其他媒体播放器才算真正有音源。这样打开没有音轨的静音视频不会暂停音乐。
     */
    private boolean hasExternalActivePlayback() {
        if (audioManager == null) return true;
        // getActivePlaybackConfigurations 是 API 26 起；低版本取不到播放器状态，
        // 保守当作“确实有音源”（焦点事件本身就是信号）。
        if (!canManageAudioFocus()) return true;
        try {
            int activeMediaPlayers = 0;
            for (AudioPlaybackConfiguration config : audioManager.getActivePlaybackConfigurations()) {
                android.media.AudioAttributes attributes = config.getAudioAttributes();
                if (attributes == null) continue;
                int usage = attributes.getUsage();
                if (usage == android.media.AudioAttributes.USAGE_MEDIA
                        || usage == android.media.AudioAttributes.USAGE_GAME
                        || usage == android.media.AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY
                        || usage == android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION
                        || usage == android.media.AudioAttributes.USAGE_ASSISTANT) {
                    activeMediaPlayers++;
                }
            }
            // 当前播放器本身也会出现在列表中；多于一个才说明有其他应用的
            // 活跃媒体播放器。没有音轨的静音视频不会新增 AudioPlaybackConfiguration。
            return activeMediaPlayers > 1;
        } catch (Throwable error) {
            // 读取失败时保守暂停，不能让真正的来电/音乐与本机叠音。
            Log.w(TAG, "读取其他应用音频输出状态失败", error);
            return true;
        }
    }

    private void abandonAudioFocus() {
        abandonAudioFocus(true);
    }

    /** @param clearIntent 是否同时清掉“因丢焦而暂停、拿到焦点后恢复”的意图 */
    private void abandonAudioFocus(boolean clearIntent) {
        mainHandler.removeCallbacks(focusLossCheck);
        if (audioManager != null && focusRequest != null) {
            try {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } catch (Throwable error) {
                Log.w(TAG, "abandonAudioFocusRequest failed", error);
            }
        }
        focusRequest = null;
        if (clearIntent) focusLossPaused = false;
    }

    private final BroadcastReceiver becomingNoisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) return;
            mainHandler.post(() -> {
                if (isPlayerPlaying()) player.pause();
            });
        }
    };

    /** 「与其他音源同时播放」开关（设置页 → 播放）。 */
    public CompletableFuture<Void> setCoPlayWithOthers(boolean enabled) {
        return command(() -> {
            coPlayWithOthers = enabled;
            applyAudioFocusMode();
            // 开启“与其他音源同时播放”= 现在就想听：之前因丢焦被暂停的，要接着放。
            if (enabled && focusLossPaused) {
                focusLossPaused = false;
                if (isPlayerReady()) player.play();
            }
        });
    }

    /** 由 Capacitor 插件同步 Activity 是否在后台。 */
    public void setAppInBackground(boolean background) {
        appInBackground = background;
    }

    /** 取出后台期间积累的媒体按键，并一次性清空，避免恢复后重复切歌。 */
    public CompletableFuture<List<String>> drainPendingMediaControls() {
        CompletableFuture<List<String>> future = new CompletableFuture<>();
        runOnMain(() -> {
            long now = SystemClock.uptimeMillis();
            List<String> controls = new ArrayList<>();
            int dropped = 0;
            while (!pendingMediaControls.isEmpty()) {
                PendingControl entry = pendingMediaControls.removeFirst();
                // 过期，或按下之后曲目已经变过（说明那一下早被原生执行了）→ 丢弃
                if (now - entry.at > PENDING_CONTROL_TTL_MS || entry.seq != sourceSeq) {
                    dropped++;
                    continue;
                }
                controls.add(entry.type);
            }
            if (dropped > 0) {
                Log.i(TAG, "丢弃过期/已过时的后台媒体按键: " + dropped);
            }
            future.complete(controls);
        });
        return future;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        // 耳机拔出（BECOMING_NOISY）暂停与音频焦点是两回事：前者必须保留，
        // 且 ExoPlayer 的这个开关不依赖焦点处理，关掉焦点自己管不受影响。
        registerReceiver(becomingNoisyReceiver,
                new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));

        AudioAttributes audioAttributes = getPlaybackAudioAttributes();

        dspProcessor = new EchoDspAudioProcessor();
        EchoDspRenderersFactory renderersFactory = new EchoDspRenderersFactory(this, dspProcessor);
        player = new ExoPlayer.Builder(this, renderersFactory).build();
        // 焦点改为自行管理（第二参 false = 不让 Media3 自动申请）：Media3 把任何焦点丢失
        // 都当暂停信号 —— 抖音这类 App 启动时抢一下瞬时焦点（并没有真的出声），
        // 音乐就被暂停了。自行管理的规则见 focusListener。
        // ⚠️ API 26 以下没有 AudioFocusRequest，自管焦点整条链跑不起来，
        // 那里必须退回 Media3 自动管理（minSdk 24）。
        player.setAudioAttributes(audioAttributes, !canManageAudioFocus());
        // Media3 在 AUDIO_BECOMING_NOISY（通常是耳机拔出）时暂停。
        player.setHandleAudioBecomingNoisy(true);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_READY) {
                    completePendingLoadIfReady();
                    // 队列项切换不经过 load()，transition 时 duration 可能仍是 TIME_UNSET。
                    if (backgroundPlaylistActive) emitDurationChange();
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
                // 真正开始出声才申请焦点：空占焦点会把别的正在放的应用挤下去
                if (isPlaying && !coPlayWithOthers) applyAudioFocusMode();
            }

            @Override
            public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                if (backgroundPlaylistActive && mediaItem != null
                        && reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) {
                    // 这是已经完成的切换，不是 NextSong 请求。前后台都只通知 JS
                    // 读取快照，禁止再调用 next/load，否则会把正在播的歌曲重开。
                    sourceSeq++;
                    emitMediaControl("NativeTrackTransition");
                    emitDurationChange();
                    emitState();
                    updatePlaybackNotification();
                }
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
                // failPendingLoad 内部已经遍历 listener 发 onError；这里再发一次会让
                // 渲染层把同一次失败处理两遍（重复弹提示，甚至连跳两首）。
                failPendingLoad(message, "media3-playback", "media3");
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
                     * Media3 默认会把按键翻译成 player 的命令。后台队列已经由 renderer
                     * 下发到原生时，直接在 Media3 playlist 内切换；没有原生下一项时，
                     * 才转成媒体控制事件交回渲染层，类型名与内核的
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
                                if (skipNativeQueueTrack(1)) return true;
                                type = "NextSong";
                                break;
                            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                                if (skipNativeQueueTrack(-1)) return true;
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
                    // 有原生预置项时直接切，后台不依赖 WebView；没有预置项时暂存
                    // NextSong，回到前台后由渲染层按真实队列/随机模式处理。
                    if (!skipNativeQueueTrack(1)) emitMediaControl("NextSong");
                    break;
                case ACTION_PREVIOUS:
                    if (!skipNativeQueueTrack(-1)) emitMediaControl("PreviousSong");
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
     * 当原生后台队列存在时，按钮直接操作 Media3 playlist；否则才交给渲染层，
     * 由 renderer 处理随机、单循环、失败跳过、私人 FM 等动态队列。
     */
    private void emitMediaControl(String type) {
        if (appInBackground) {
            // 这里不能只依赖 notifyListeners：后台 WebView 可能完全不调 JS，
            // 但通知栏按钮本身已经被 Android 消费掉了。
            if (pendingMediaControls.size() >= 16) pendingMediaControls.removeFirst();
            pendingMediaControls.addLast(new PendingControl(type, SystemClock.uptimeMillis(), sourceSeq));
            Log.i(TAG, "后台媒体按键已暂存: " + type);
            return;
        }
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
            resetBackgroundQueueState();
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
            // 新音源接手：上一次的后台队列映射全部作废，避免旧的 mediaId→业务 ID 映射串到新歌单。
            resetBackgroundQueueState();
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
            // 用户主动暂停：清掉“等焦点恢复就继续播”的意图，否则通话中途手动暂停后
            // 对方释放焦点会把音乐又自动放起来。
            focusLossPaused = false;
            mainHandler.removeCallbacks(focusLossCheck);
            player.pause();
            // 暂停就不再占用焦点：继续占着会把别的 App 挤掉，而且一旦被抢走
            // 就会走 LOSS 分支留下“拿不到焦点”的后遗症。恢复播放时
            // onIsPlayingChanged(true) → applyAudioFocusMode() 会重新申请。
            abandonAudioFocus();
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
            resetBackgroundQueueState();
            abandonAudioFocus();
            stopPlaybackForeground();
            emitState();
        });
    }

    /**
     * 清空后台队列相关状态。
     *
     * ⚠️ 必须在 load()/stop()/beginSourceChange() 里都调：残留的
     * backgroundExpectedCount / backgroundPlaylistActive 会让 skipNativeQueueTrack
     * 要么永远退回渲染层（表现为点了没反应后迟一步重开音源），要么把按键吞掉。
     */
    private void resetBackgroundQueueState() {
        backgroundPlaylistActive = false;
        backgroundExpectedCount = 1;
        backgroundInitialMediaId = "";
        backgroundInitialTrackId = "";
        backgroundQueueIndices.clear();
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
        return command(() -> {
            // 内核每次 load 后都会 setLoopFile(false)。原生队列接管模式后，
            // 这个旧单文件开关不能再覆盖用户选择的循环/随机。
            if (backgroundRepeatMode >= 0) applyBackgroundPlaybackMode();
            else player.setRepeatMode(loop ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
        });
    }

    public CompletableFuture<Void> setPauseOnDeviceDisconnect(boolean enabled) {
        return command(() -> player.setHandleAudioBecomingNoisy(enabled));
    }

    /**
     * 在 WebView 即将退后台时预置一首已经解析好的下一首。
     *
     * Android 的前台服务和 ExoPlayer 可以继续跑，但后台 WebView 不一定还能执行
     * resolver/定时器。把下一首放进原生 playlist 后，EOF 和通知栏 Next 都能在
     * JS 不运行时直接切换；恢复前台后再由 NextSong 事件补齐 JS 队列状态。
     */
    public CompletableFuture<Void> setBackgroundNextSource(
            String url, String trackId, String title, String artist, String album,
            String coverUrl, long durationMs, boolean append, String currentTrackId,
            int queueIndex, int currentQueueIndex, int expectedGeneration) {
        return command(() -> {
            if (expectedGeneration >= 0 && expectedGeneration != generation) return;
            if (url == null || url.trim().isEmpty()) {
                throw new IllegalArgumentException("后台下一首音频地址为空");
            }
            if (player.getCurrentMediaItem() == null) return;
            if (!append) {
                // 初始曲目 mediaId 是 hppmusic-序号，也要能恢复它的业务 ID；
                // 列表循环回到第一项、或按上一首返回时不能靠 next() 猜。
                backgroundInitialMediaId = player.getCurrentMediaItem().mediaId;
                backgroundInitialTrackId = currentTrackId == null ? "" : currentTrackId;
                backgroundQueueIndices.put(backgroundInitialMediaId, currentQueueIndex);
            }
            int currentIndex = player.getCurrentMediaItemIndex();
            int itemCount = player.getMediaItemCount();
            if (currentIndex < 0) return;
            if (!append && itemCount > currentIndex + 1) {
                player.removeMediaItems(currentIndex + 1, itemCount);
            }
            MediaMetadata.Builder metadata = new MediaMetadata.Builder();
            if (title != null) metadata.setTitle(title);
            if (artist != null) metadata.setArtist(artist);
            if (album != null) metadata.setAlbumTitle(album);
            if (coverUrl != null && !coverUrl.isEmpty()) {
                metadata.setArtworkUri(Uri.parse(coverUrl));
            }
            MediaItem item = new MediaItem.Builder()
                    .setMediaId(BACKGROUND_NEXT_PREFIX + String.valueOf(trackId))
                    .setUri(Uri.parse(url))
                    .setMediaMetadata(metadata.build())
                    .build();
            // 插入而非按取链完成顺序追加：从列表中间开始时，顺序播放不能
            // 把前半张歌单放到末尾；随机则交给 ExoPlayer 的 shuffleOrder。
            for (int i = 0; i < player.getMediaItemCount(); i++) {
                if (player.getMediaItemAt(i).mediaId.equals(item.mediaId)) return;
            }
            int insertAt = player.getMediaItemCount();
            if (queueIndex >= 0) {
                for (int i = 0; i < player.getMediaItemCount(); i++) {
                    Integer index = backgroundQueueIndices.get(player.getMediaItemAt(i).mediaId);
                    if (index != null && index > queueIndex) { insertAt = i; break; }
                }
            }
            backgroundQueueIndices.put(item.mediaId, queueIndex);
            player.addMediaItem(insertAt, item);
            backgroundPlaylistActive = true;
            applyBackgroundPlaybackMode();
            // 当前曲目仍在播放时不主动 prepare，ExoPlayer 会在当前项结束前加载下一项。
            updatePlaybackNotification();
        });
    }

    /** 清掉当前曲目之后的原生后台队列，不停止当前播放。 */
    public CompletableFuture<Void> clearBackgroundQueue(int expectedItemCount) {
        return command(() -> {
            backgroundExpectedCount = Math.max(1, expectedItemCount);
            if (player.getCurrentMediaItem() != null) {
                int currentIndex = player.getCurrentMediaItemIndex();
                int itemCount = player.getMediaItemCount();
                if (currentIndex >= 0 && itemCount > currentIndex + 1) {
                    player.removeMediaItems(currentIndex + 1, itemCount);
                }
                if (currentIndex > 0) player.removeMediaItems(0, currentIndex);
            }
            backgroundPlaylistActive = false;
            backgroundQueueIndices.clear();
            applyBackgroundPlaybackMode();
        });
    }

    /** 本轮取链结束后，把失败歌曲视为不可用项；取链中不能提前把空缺当边界。 */
    public CompletableFuture<Void> finishBackgroundQueue(int expectedGeneration, String currentTrackId) {
        return command(() -> {
            if (expectedGeneration >= 0 && expectedGeneration != generation) return;
            if (player.getCurrentMediaItem() == null) return;
            if (!backgroundPlaylistActive) {
                backgroundInitialMediaId = player.getCurrentMediaItem().mediaId;
                backgroundInitialTrackId = currentTrackId;
            }
            backgroundExpectedCount = player.getMediaItemCount();
            backgroundPlaylistActive = true;
            applyBackgroundPlaybackMode();
        });
    }

    /** 0=顺序，1=单曲循环，2=列表循环，3=随机。模式变化不清队列、不重开音源。 */
    public CompletableFuture<Void> setBackgroundRepeatMode(int mode) {
        return command(() -> {
            if (mode < 0 || mode > 3) throw new IllegalArgumentException("播放模式无效");
            backgroundRepeatMode = mode;
            applyBackgroundPlaybackMode();
        });
    }

    private void applyBackgroundPlaybackMode() {
        player.setShuffleModeEnabled(backgroundRepeatMode == 3);
        boolean canRepeatList = backgroundExpectedCount == 1 || player.getMediaItemCount() > 1;
        player.setRepeatMode(backgroundRepeatMode == 1 ? Player.REPEAT_MODE_ONE
                : backgroundRepeatMode >= 2 && canRepeatList ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
    }

    private boolean skipNativeQueueTrack(int direction) {
        if (!backgroundPlaylistActive || player.getMediaItemCount() == 0) return false;
        // 暂时只有 [A,D] 时不能把 D 的上一首当成 A；列表还在取链时交回逻辑队列。
        if (player.getMediaItemCount() < backgroundExpectedCount) return false;
        int nextIndex = direction > 0 ? player.getNextMediaItemIndex() : player.getPreviousMediaItemIndex();
        // 单曲循环只约束自然结束，用户明确上下首仍然走列表并允许首尾切换。
        if (nextIndex == C.INDEX_UNSET && backgroundRepeatMode == 1) {
            nextIndex = direction > 0 ? 0 : player.getMediaItemCount() - 1;
        }
        if (nextIndex == C.INDEX_UNSET) {
            // 顺序模式已在末尾/开头：本次没做任何事，必须交回渲染层。
            // 旧实现无条件 return true，导致“下一首”被吞掉（既不切歌也不报错）。
            return false;
        }
        player.seekTo(nextIndex, 0);
        player.play();
        return true;
    }

    public CompletableFuture<Boolean> skipQueueTrack(int direction) {
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        runOnMain(() -> {
            try { future.complete(isPlayerReady() && skipNativeQueueTrack(direction)); }
            catch (Throwable error) { future.completeExceptionally(error); }
        });
        return future;
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
                state.putString("mediaId", "");
                state.putInt("generation", generation);
                state.putLong("sampledAt", System.currentTimeMillis());
                future.complete(state);
                return;
            }
            try {
                state.putBoolean("playing", player.isPlaying());
                state.putBoolean("paused", !player.isPlaying());
                state.putBoolean("ended", player.getPlaybackState() == Player.STATE_ENDED);
                state.putDouble("duration", seconds(player.getDuration()));
                state.putDouble("timePos", seconds(player.getCurrentPosition()));
                state.putDouble("volume", player.getVolume() * 100.0);
                state.putDouble("speed", player.getPlaybackParameters().speed);
                state.putInt("trackSeq", sourceSeq);
                MediaItem current = player.getCurrentMediaItem();
                state.putString("mediaId", current == null ? "" : current.mediaId);
                String trackId = "";
                if (current != null) {
                    if (current.mediaId.startsWith(BACKGROUND_NEXT_PREFIX)) {
                        trackId = current.mediaId.substring(BACKGROUND_NEXT_PREFIX.length());
                    } else if (backgroundPlaylistActive && current.mediaId.equals(backgroundInitialMediaId)) {
                        trackId = backgroundInitialTrackId;
                    }
                }
                state.putString("trackId", trackId);
                state.putString("path", current == null || current.localConfiguration == null
                        ? "" : current.localConfiguration.uri.toString());
                state.putInt("repeatMode", player.getRepeatMode());
                state.putBoolean("shuffleModeEnabled", player.getShuffleModeEnabled());
                state.putInt("queueSize", player.getMediaItemCount());
                state.putInt("queueIndex", player.getCurrentMediaItemIndex());
                state.putBoolean("backgroundQueueActive", backgroundPlaylistActive);
                state.putBoolean("playWhenReady", player.getPlayWhenReady());
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
        unregisterReceiver(becomingNoisyReceiver);
        abandonAudioFocus();
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
