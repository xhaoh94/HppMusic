package com.hppmusic.app;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
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

import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Media3 后台播放服务。
 *
 * ExoPlayer 负责音频焦点、音频输出和 becoming-noisy（耳机拔出）处理，
 * MediaSessionService 负责把播放状态暴露给系统媒体控件和锁屏通知。
 */
@UnstableApi
public final class EchoPlaybackService extends MediaSessionService {
    /** DSP 参数诊断：设置页能拖但声音不变时，用 `adb logcat -s EchoDsp` 就能分清是没下发还是没生效。 */
    private static final String DSP_TAG = "EchoDsp";
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
                .build();
        mainHandler.post(positionTicker);
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
            pendingLoad = new PendingLoad(future, requestedRequestSeq, loadGeneration, seq, url);
            player.setMediaItem(item);
            player.prepare();
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
        });
    }

    public CompletableFuture<Void> pause() {
        return command(() -> player.pause());
    }

    public CompletableFuture<Void> stop() {
        return command(() -> {
            player.stop();
            player.clearMediaItems();
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

    private void emitTimeUpdate() {
        double time = seconds(player.getCurrentPosition());
        long now = System.currentTimeMillis();
        for (Listener listener : listeners) {
            listener.onTimeUpdate(time, now, sourceSeq, generation);
        }
    }

    private void emitDurationChange() {
        double duration = seconds(player.getDuration());
        for (Listener listener : listeners) {
            listener.onDurationChange(duration, sourceSeq, generation);
        }
    }

    private void emitState() {
        if (player == null) return;
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
