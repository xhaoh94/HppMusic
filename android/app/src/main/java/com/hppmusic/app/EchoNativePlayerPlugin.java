package com.hppmusic.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import android.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/** Capacitor bridge for the Media3 native player and MediaSession. */
@CapacitorPlugin(name = "EchoNativePlayer")
public final class EchoNativePlayerPlugin extends Plugin implements EchoPlaybackService.Listener {

    private static final String TAG = "EchoNativePlayer";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 7011;
    private static final int SERVICE_READY_TIMEOUT_MS = 5_000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private EchoPlaybackService service;
    private boolean listenerAttached;
    private boolean appInBackground;

    @Override
    public void load() {
        super.load();
        ensureService(ignored -> null);
    }

    @Override
    protected void handleOnPause() {
        appInBackground = true;
        if (service != null && !service.isDestroyed()) service.setAppInBackground(true);
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        appInBackground = false;
        if (service != null && !service.isDestroyed()) service.setAppInBackground(false);
        super.handleOnResume();
    }

    @Override
    protected void handleOnDestroy() {
        detachServiceListener();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        call.resolve(result);
    }

    @PluginMethod
    public void beginSourceChange(PluginCall call) {
        withService(call, EchoPlaybackService::beginSourceChange, result -> {
            JSObject value = new JSObject();
            value.put("requestId", result);
            return value;
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url", "");
        int requestId = call.getInt("requestId", -1);
        withService(call, service -> service.load(url, requestId), result -> {
            JSObject value = new JSObject();
            value.put("duration", result.duration);
            value.put("seq", result.seq);
            return value;
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        int requestId = call.getInt("requestId", -1);
        withService(call, service -> service.play(requestId), ignored -> new JSObject());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withService(call, EchoPlaybackService::pause, ignored -> new JSObject());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withService(call, EchoPlaybackService::stop, ignored -> new JSObject());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        double time = call.getDouble("time", 0.0);
        withService(call, service -> service.seek(time), ignored -> new JSObject());
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        double volume = call.getDouble("volume", 100.0);
        withService(call, service -> service.setVolume(volume), ignored -> new JSObject());
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        double speed = call.getDouble("speed", 1.0);
        withService(call, service -> service.setSpeed(speed), ignored -> new JSObject());
    }

    /** 「与其他音源同时播放」：开启后不申请音频焦点、不响应丢焦，永不因别的 App 暂停。 */
    @PluginMethod
    public void setCoPlayWithOthers(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        withService(call, service -> service.setCoPlayWithOthers(enabled), ignored -> new JSObject());
    }

    @PluginMethod
    public void setLoopFile(PluginCall call) {
        boolean loop = call.getBoolean("loop", false);
        withService(call, service -> service.setLoopFile(loop), ignored -> new JSObject());
    }

    @PluginMethod
    public void setPauseOnDeviceDisconnect(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        withService(call, service -> service.setPauseOnDeviceDisconnect(enabled), ignored -> new JSObject());
    }

    @PluginMethod
    public void setBackgroundNextSource(PluginCall call) {
        String url = call.getString("url", "");
        String trackId = call.getString("trackId", "");
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        String coverUrl = call.getString("coverUrl", "");
        long durationMs = call.getLong("durationMs", 0L);
        boolean append = call.getBoolean("append", false);
        String currentTrackId = call.getString("currentTrackId", "");
        int queueIndex = call.getInt("queueIndex", -1);
        int currentQueueIndex = call.getInt("currentQueueIndex", -1);
        int expectedGeneration = call.getInt("generation", -1);
        withService(call,
                service -> service.setBackgroundNextSource(
                        url, trackId, title, artist, album, coverUrl, durationMs, append, currentTrackId,
                        queueIndex, currentQueueIndex, expectedGeneration),
                ignored -> new JSObject());
    }

    @PluginMethod
    public void clearBackgroundQueue(PluginCall call) {
        int expectedItemCount = call.getInt("expectedItemCount", 1);
        withService(call, service -> service.clearBackgroundQueue(expectedItemCount), ignored -> new JSObject());
    }

    @PluginMethod
    public void finishBackgroundQueue(PluginCall call) {
        int generation = call.getInt("generation", -1);
        String currentTrackId = call.getString("currentTrackId", "");
        withService(call, service -> service.finishBackgroundQueue(generation, currentTrackId),
                ignored -> new JSObject());
    }

    @PluginMethod
    public void setBackgroundRepeatMode(PluginCall call) {
        int mode = call.getInt("mode", 0);
        withService(call, service -> service.setBackgroundRepeatMode(mode), ignored -> new JSObject());
    }

    @PluginMethod
    public void skipQueueTrack(PluginCall call) {
        int direction = call.getInt("direction", 1);
        withService(call, service -> service.skipQueueTrack(direction),
                handled -> new JSObject().put("handled", handled));
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withService(call, EchoPlaybackService::getState, this::bundleToState);
    }

    @PluginMethod
    public void getPendingMediaControls(PluginCall call) {
        withService(call, EchoPlaybackService::drainPendingMediaControls, controls -> {
            JSArray events = new JSArray();
            for (String control : controls) events.put(control);
            return new JSObject().put("events", events);
        });
    }

    @PluginMethod
    public void cacheAudioResource(PluginCall call) {
        String logicalName = call.getString("name", "resource");
        String encoded = call.getString("data", "");
        if (encoded == null || encoded.isEmpty()) {
            call.reject("音效资源数据为空", "invalid-audio-resource");
            return;
        }
        try {
            String safeName = logicalName.replaceAll("[^a-zA-Z0-9._-]", "_");
            File directory = new File(getContext().getFilesDir(), "audio-effects");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建音效目录");
            File target = new File(directory, safeName);
            try (FileOutputStream output = new FileOutputStream(target)) {
                output.write(Base64.decode(encoded, Base64.DEFAULT));
            }
            JSObject result = new JSObject();
            result.put("path", target.getAbsolutePath());
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(error.getMessage() == null ? "音效资源保存失败" : error.getMessage(), "audio-resource-error");
        }
    }

    @PluginMethod
    public void audioResourceExists(PluginCall call) {
        String path = call.getString("path", "");
        JSObject result = new JSObject();
        result.put("exists", isOwnedAudioResource(path) && new File(path).isFile());
        call.resolve(result);
    }

    @PluginMethod
    public void deleteAudioResource(PluginCall call) {
        String path = call.getString("path", "");
        call.resolve(new JSObject().put("ok", isOwnedAudioResource(path) && new File(path).delete()));
    }

    private boolean isOwnedAudioResource(String path) {
        if (path == null || path.isEmpty()) return false;
        try {
            String root = new File(getContext().getFilesDir(), "audio-effects").getCanonicalPath();
            String target = new File(path).getCanonicalPath();
            return target.startsWith(root + File.separator);
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * 音效。
     *
     * impulseResponsePath 是卷积音效（WAV/IRS），centerChannel 是人声/伴奏
     * （Android 本地中置算法），两者可同时生效，所以一起下发。
     */
    @PluginMethod
    public void setAudioEffect(PluginCall call) {
        JSObject options = call.getData();
        String path = options == null ? "" : options.getString("impulseResponsePath", "");
        double mix = options == null ? 1.0 : options.optDouble("impulseResponseMix", 1.0);
        String centerChannel = options == null ? "" : options.getString("centerChannel", "");
        withService(call, service -> service.setAudioEffect(
                        path == null || path.isEmpty() ? null : path,
                        mix,
                        centerChannel == null || centerChannel.isEmpty() ? null : centerChannel),
                ignored -> new JSObject());
    }

    /** 10 段均衡器：gains 长度按频段数（10），越界会自动 clamp。 */
    @PluginMethod
    public void setEqualizer(PluginCall call) {
        JSArray input = call.getArray("gains");
        float[] gains = new float[10];
        if (input != null) {
            int count = Math.min(gains.length, input.length());
            for (int index = 0; index < count; index++) {
                gains[index] = (float) input.optDouble(index, 0.0);
            }
        }
        withService(call, service -> service.setEqualizer(gains), ignored -> new JSObject());
    }

    /** 音量均衡增益（dB），由渲染层 EBU R128 计算后下发。 */
    @PluginMethod
    public void setNormalizationGain(PluginCall call) {
        double gainDb = call.getDouble("gainDb", 0.0);
        withService(call, service -> service.setNormalizationGain(gainDb), ignored -> new JSObject());
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        String coverUrl = call.getString("coverUrl", "");
        long durationMs = call.getLong("durationMs", 0L);
        withService(call, service -> service.updateMetadata(title, artist, album, coverUrl, durationMs),
                ignored -> new JSObject());
    }

    @PluginMethod
    public void updateState(PluginCall call) {
        String status = call.getString("status", "Paused");
        double playbackRate = call.getDouble("playbackRate", 1.0);
        withService(call, service -> service.updateState(status, playbackRate), ignored -> new JSObject());
    }

    @PluginMethod
    public void updateTimeline(PluginCall call) {
        double currentTimeMs = call.getDouble("currentTimeMs", 0.0);
        double totalTimeMs = call.getDouble("totalTimeMs", 0.0);
        boolean isPlaying = call.getBoolean("isPlaying", false);
        double playbackRate = call.getDouble("playbackRate", 1.0);
        withService(call, service -> service.updateTimeline(currentTimeMs, totalTimeMs, isPlaying, playbackRate),
                ignored -> new JSObject());
    }

    @PluginMethod
    public void updateSkipIntervals(PluginCall call) {
        double forwardMs = call.getDouble("forwardMs", 0.0);
        double backwardMs = call.getDouble("backwardMs", 0.0);
        withService(call, service -> service.updateSkipIntervals(forwardMs, backwardMs), ignored -> new JSObject());
    }

    @PluginMethod
    public void notificationPermission(PluginCall call) {
        JSObject result = notificationPermissionState();
        call.resolve(result);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject result = notificationPermissionState();
            result.put("requested", false);
            call.resolve(result);
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            JSObject result = notificationPermissionState();
            result.put("requested", false);
            call.resolve(result);
            return;
        }
        ActivityCompat.requestPermissions(getActivity(),
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_PERMISSION_REQUEST);
        JSObject result = notificationPermissionState();
        result.put("requested", true);
        call.resolve(result);
    }

    @PluginMethod
    public void mediaControlsAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("notificationPermission", hasNotificationPermission());
        call.resolve(result);
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject notificationPermissionState() {
        boolean granted = hasNotificationPermission();
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("required", Build.VERSION.SDK_INT >= 33);
        return result;
    }

    private JSObject bundleToState(Bundle state) {
        JSObject result = new JSObject();
        result.put("playing", state.getBoolean("playing"));
        result.put("paused", state.getBoolean("paused"));
        result.put("ended", state.getBoolean("ended"));
        result.put("duration", state.getDouble("duration"));
        result.put("timePos", state.getDouble("timePos"));
        result.put("volume", state.getDouble("volume"));
        result.put("speed", state.getDouble("speed"));
        result.put("trackSeq", state.getInt("trackSeq"));
        result.put("generation", state.getInt("generation"));
        result.put("trackId", state.getString("trackId", ""));
        result.put("path", state.getString("path", ""));
        result.put("repeatMode", state.getInt("repeatMode"));
        result.put("shuffleModeEnabled", state.getBoolean("shuffleModeEnabled"));
        result.put("queueSize", state.getInt("queueSize"));
        result.put("queueIndex", state.getInt("queueIndex"));
        result.put("backgroundQueueActive", state.getBoolean("backgroundQueueActive"));
        result.put("playWhenReady", state.getBoolean("playWhenReady"));
        result.put("mediaId", state.getString("mediaId", ""));
        result.put("sampledAt", state.getLong("sampledAt"));
        return result;
    }

    private void ensureService(Function<EchoPlaybackService, Void> ready) {
        // ⚠️ 必须连着 `!isDestroyed()` 一起判：播放停止后 Media3 会放弃前台状态，
        // 系统可以随时回收这个服务（onDestroy 里 player 被置 null），
        // 而这里缓存的引用仍然非空 —— 旧实现就因此拿着已销毁的实例下发 load()，
        // 在原生侧抛 NPE 直接把进程干掉（切歌/重新播放时必崩）。
        if (service != null && !service.isDestroyed()) {
            ready.apply(service);
            return;
        }
        // 缓存已失效：先解绑（removeListener 对已销毁的服务是安全的），再重新拉起
        if (service != null) detachServiceListener();

        EchoPlaybackService existing = EchoPlaybackService.getInstance();
        if (existing != null && !existing.isDestroyed()) {
            attachService(existing);
            ready.apply(existing);
            return;
        }

        Context context = getContext();
        android.content.Intent intent = new android.content.Intent(context, EchoPlaybackService.class);
        try {
            // 初始化时尚无 MediaItem，Media3 不会立即生成播放通知。
            // 此时调用 startForegroundService 会触发“必须及时 startForeground”的
            // 系统倒计时，并在用户切后台时杀掉整个应用。只启动普通服务，
            // 真正 play 后由 MediaSessionService 按播放状态自行晋升为前台服务。
            context.startService(intent);
        } catch (RuntimeException error) {
            // 后台禁止创建普通服务时，后续调用返回 service-unavailable。
            // 正常后台播放使用已经存活的 MediaSessionService，不重新创建服务。
            Log.w(TAG, "startService 被系统拒绝，后续操作将返回 service-unavailable", error);
        }
        waitForService(ready, System.currentTimeMillis());
    }

    private void waitForService(Function<EchoPlaybackService, Void> ready, long startedAt) {
        EchoPlaybackService current = EchoPlaybackService.getInstance();
        if (current != null && !current.isDestroyed()) {
            attachService(current);
            ready.apply(current);
            return;
        }
        if (System.currentTimeMillis() - startedAt >= SERVICE_READY_TIMEOUT_MS) {
            ready.apply(null);
            return;
        }
        mainHandler.postDelayed(() -> waitForService(ready, startedAt), 25);
    }

    private void attachService(EchoPlaybackService current) {
        if (service == current && listenerAttached) return;
        detachServiceListener();
        service = current;
        service.setAppInBackground(appInBackground);
        service.addListener(this);
        listenerAttached = true;
    }

    private void detachServiceListener() {
        if (service != null && listenerAttached) service.removeListener(this);
        listenerAttached = false;
        service = null;
    }

    private interface ServiceAction<T> {
        CompletableFuture<T> apply(EchoPlaybackService service);
    }

    private <T> void withService(PluginCall call, ServiceAction<T> action,
                                 Function<T, JSObject> resultMapper) {
        ensureService(current -> {
            if (current == null) {
                call.reject("Media3 播放服务启动失败", "service-unavailable");
                return null;
            }
            try {
                action.apply(current).whenComplete((result, error) -> {
                    if (error != null) {
                        Throwable cause = error.getCause() != null ? error.getCause() : error;
                        call.reject(cause.getMessage() == null ? "原生播放器操作失败" : cause.getMessage(),
                                "native-player-error");
                    } else {
                        call.resolve(resultMapper.apply(result));
                    }
                });
            } catch (Throwable error) {
                call.reject(error.getMessage() == null ? "原生播放器操作失败" : error.getMessage(),
                        "native-player-error");
            }
            return null;
        });
    }

    // ── Service event -> Capacitor event ──

    private JSObject context(long sampledAt, int trackSeq, int eventGeneration) {
        JSObject result = new JSObject();
        result.put("trackSeq", trackSeq);
        result.put("generation", eventGeneration);
        result.put("sampledAt", sampledAt);
        return result;
    }

    @Override
    public void onTimeUpdate(double time, long sampledAt, int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("time", time);
        notifyListeners("timeUpdate", result);
    }

    @Override
    public void onDurationChange(double duration, int trackSeq, int eventGeneration) {
        JSObject result = context(System.currentTimeMillis(), trackSeq, eventGeneration);
        result.put("duration", duration);
        notifyListeners("durationChange", result);
    }

    @Override
    public void onSeeked(double time, long sampledAt, int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("time", time);
        notifyListeners("seeked", result);
    }

    @Override
    public void onSeekStateChange(boolean active, double time, long sampledAt,
                                  int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("active", active);
        result.put("time", time);
        notifyListeners("seekStateChange", result);
    }

    @Override
    public void onStateChange(boolean playing, boolean paused, double time, long sampledAt,
                              int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("playing", playing);
        result.put("paused", paused);
        result.put("timePos", time);
        notifyListeners("stateChange", result);
    }

    @Override
    public void onPlaybackEnd(String reason, long sampledAt, int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("reason", reason);
        notifyListeners("playbackEnd", result);
    }

    @Override
    public void onFileLoaded(String url, double duration, int seq, long sampledAt, int eventGeneration) {
        JSObject result = context(sampledAt, seq, eventGeneration);
        result.put("path", url);
        result.put("seq", seq);
        result.put("duration", duration);
        notifyListeners("fileLoaded", result);
    }

    @Override
    public void onError(String message, String errorCode, String reason, long sampledAt,
                        int trackSeq, int eventGeneration) {
        JSObject result = context(sampledAt, trackSeq, eventGeneration);
        result.put("message", message);
        result.put("errorCode", errorCode);
        result.put("reason", reason);
        notifyListeners("error", result);
    }

    @Override
    public void onMediaControl(String type, @Nullable Double position, @Nullable Double offset) {
        JSObject result = new JSObject();
        result.put("type", type);
        if (position != null) result.put("positionMs", position * 1000.0);
        if (offset != null) result.put("offsetMs", offset * 1000.0);
        notifyListeners("mediaControl", result);
    }
}
