import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Media3 Capacitor 插件的 JS 侧类型。原生实现位于 EchoNativePlayerPlugin。
 * 事件 payload 均携带 trackSeq/generation，供 PlayerEngine 丢弃旧源的迟到事件。
 */
interface NativePlayerPlugin {
  available(): Promise<{ available: boolean }>;
  beginSourceChange(): Promise<{ requestId: number }>;
  load(options: { url: string; requestId?: number }): Promise<{ seq: number; duration: number }>;
  play(options?: { requestId?: number }): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(options: { time: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  /** 渲染层诊断日志：release 包里 console 不进 logcat，排查用。 */
  log(options: { message: string }): Promise<void>;
  /** 原生音量斜坡：WebView 后台会节流 setInterval，淡入淡出必须在这一层做。 */
  setVolumeRamp(options: { from: number; to: number; durationMs: number }): Promise<void>;
  /** 淡出到静音后暂停并还原音量，整段在原生完成，调用立即返回。 */
  pauseWithFade(options: { durationMs: number; restoreVolume: number }): Promise<void>;
  setSpeed(options: { speed: number }): Promise<void>;
  setLoopFile(options: { loop: boolean }): Promise<void>;
  setPauseOnDeviceDisconnect(options: { enabled: boolean }): Promise<void>;
  setBackgroundNextSource(options: {
    url: string;
    trackId: string;
    title: string;
    artist: string;
    album: string;
    coverUrl?: string;
    durationMs?: number;
    append?: boolean;
    currentTrackId?: string;
    queueIndex?: number;
    currentQueueIndex?: number;
    generation?: number;
  }): Promise<void>;
  clearBackgroundQueue(options: { expectedItemCount: number }): Promise<void>;
  finishBackgroundQueue(options: { generation?: number; currentTrackId: string }): Promise<void>;
  setBackgroundRepeatMode(options: { mode: number }): Promise<void>;
  skipQueueTrack(options: { direction: number }): Promise<{ handled: boolean }>;
  setCoPlayWithOthers(options: { enabled: boolean }): Promise<void>;
  getPendingMediaControls(): Promise<{ events: string[] }>;
  getState(): Promise<{
    playing: boolean;
    paused: boolean;
    ended?: boolean;
    duration: number;
    timePos: number;
    volume: number;
    speed: number;
    trackSeq: number;
    generation: number;
    mediaId?: string;
    trackId?: string;
    path?: string;
    backgroundQueueActive?: boolean;
    playWhenReady?: boolean;
    sampledAt: number;
  }>;
  cacheAudioResource(options: { name: string; data: string }): Promise<{ path: string }>;
  audioResourceExists(options: { path: string }): Promise<{ exists: boolean }>;
  deleteAudioResource(options: { path: string }): Promise<{ ok: boolean }>;
  setAudioEffect(options: {
    impulseResponsePath?: string;
    impulseResponseMix?: number;
  }): Promise<void>;
  setEqualizer(options: { gains: number[] }): Promise<void>;
  setNormalizationGain(options: { gainDb: number }): Promise<void>;
  updateMetadata(options: {
    title: string;
    artist: string;
    album: string;
    coverUrl?: string;
    durationMs?: number;
  }): Promise<void>;
  updateState(options: { status: string; playbackRate: number }): Promise<void>;
  updateTimeline(options: {
    currentTimeMs: number;
    totalTimeMs: number;
    isPlaying: boolean;
    playbackRate: number;
  }): Promise<void>;
  updateSkipIntervals(options: { forwardMs: number; backwardMs: number }): Promise<void>;
  mediaControlsAvailable(): Promise<{ available: boolean; notificationPermission: boolean }>;
  notificationPermission(): Promise<{ granted: boolean; required: boolean }>;
  requestNotificationPermission(): Promise<{
    granted: boolean;
    required: boolean;
    requested: boolean;
  }>;
  addListener(
    eventName: string,
    listener: (payload: any) => void,
  ): Promise<PluginListenerHandle>;
}

const NativePlayer = registerPlugin<NativePlayerPlugin>('EchoNativePlayer');

const toBase64 = (data: ArrayBuffer): string => {
  const bytes = new Uint8Array(data);
  let output = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(output);
};

export const cacheNativeAudioResource = async (name: string, data: ArrayBuffer) =>
  (await NativePlayer.cacheAudioResource({ name, data: toBase64(data) })).path;

export const nativeAudioResourceExists = async (path: string) =>
  (await NativePlayer.audioResourceExists({ path })).exists;

export const deleteNativeAudioResource = async (path: string) =>
  (await NativePlayer.deleteAudioResource({ path })).ok;

type Unsubscribe = () => void;
type PlaybackContext = {
  trackSeq?: number;
  generation?: number;
  sampledAt?: number;
};

type PlayerBridge = {
  beginSourceChange: () => Promise<number>;
  load: (url: string, requestId?: number) => Promise<{ seq: number; duration: number }>;
  loadMkvTrack: (url: string, trackId: number, requestId?: number) => Promise<never>;
  switchSource: (url: string, trackId?: number | null) => Promise<never>;
  play: (requestId?: number) => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  seek: (time: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  /** 渲染层诊断日志（走原生 logcat，tag = EchoJS）。 */
  debugLog: (message: string) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setLoopFile: (loop: boolean) => Promise<void>;
  setPauseOnDeviceDisconnect: (enabled: boolean) => Promise<void>;
  setBackgroundNextSource: (options: {
    url: string;
    trackId: string;
    title: string;
    artist: string;
    album: string;
    coverUrl?: string;
    durationMs?: number;
    append?: boolean;
    currentTrackId?: string;
    queueIndex?: number;
    currentQueueIndex?: number;
    generation?: number;
  }) => Promise<void>;
  clearBackgroundQueue: (expectedItemCount?: number) => Promise<void>;
  finishBackgroundQueue: (generation: number | undefined, currentTrackId: string) => Promise<void>;
  setBackgroundRepeatMode: (mode: number) => Promise<void>;
  skipQueueTrack: (direction: number) => Promise<boolean>;
  setCoPlayWithOthers: (enabled: boolean) => Promise<void>;
  drainPendingMediaControls: () => Promise<string[]>;
  getState: () => Promise<{
    playing: boolean;
    paused: boolean;
    ended?: boolean;
    duration: number;
    timePos: number;
    volume: number;
    speed: number;
    trackSeq: number;
    generation: number;
    mediaId?: string;
    trackId?: string;
    path?: string;
    backgroundQueueActive?: boolean;
    playWhenReady?: boolean;
    sampledAt: number;
  }>;
  available: () => Promise<boolean>;
  playWithFade: (targetVolume: number, durationMs: number, requestId?: number) => Promise<void>;
  pauseWithFade: (savedVolume: number, durationMs: number) => Promise<void>;
  fade: (from: number, to: number, durationMs: number) => Promise<void>;
  cancelFade: () => Promise<void>;
  /**
   * 下面这四个在桌面 electron.d.ts 里被声明成 `(...args: unknown[]) => Promise<never>`
   * （即"调用即拒编"），因为桌面端把它们当作"不存在的功能"。
   * 但 Android 侧确实实现了均衡器与响度归一化（原生 EchoDspAudioProcessor），
   * 所以这里按**真实实现**声明参数与返回，不要再跟着桌面的"永不可用"写法。
   */
  setEqualizer: (gains: number[]) => Promise<void>;
  setAudioEffect: (options: { impulseResponsePath?: string; impulseResponseMix?: number } | null) => Promise<void>;
  setNormalizationGain: (gainDb: number) => Promise<void>;
  // 以下确实没有对应物，保持"空实现/不可用"，且不能伪装成成功：
  selectDspProvider: () => Promise<null>;
  listDspProviders: () => Promise<never[]>;
  inspectDspProvider: () => Promise<null>;
  getAudioGraph: () => Promise<null>;
  setAudioGraphParameter: () => Promise<void>;
  setAudioGraphPlan: () => Promise<void>;
  setAudioOutput: () => Promise<void>;
  getAudioDevices: () => Promise<never[]>;
  onTimeUpdate: (handler: (payload: { time: number } & PlaybackContext) => void) => Unsubscribe;
  onDurationChange: (handler: (duration: number) => void) => Unsubscribe;
  onSeeked: (handler: (time: number) => void) => Unsubscribe;
  onSeekStateChange: (handler: (payload: any) => void) => Unsubscribe;
  onStateChange: (handler: (payload: any) => void) => Unsubscribe;
  onPlaybackEnd: (handler: (reason: string, context?: PlaybackContext) => void) => Unsubscribe;
  onError: (handler: (payload: { message: string }) => void) => Unsubscribe;
};

type MediaControlsBridge = {
  updateMetadata: (payload: {
    title: string;
    artist: string;
    album: string;
    coverUrl?: string;
    durationMs?: number;
  }) => Promise<void>;
  updateState: (payload: { status: string; playbackRate: number }) => Promise<void>;
  updateTimeline: (payload: {
    currentTimeMs: number;
    totalTimeMs: number;
    isPlaying: boolean;
    playbackRate: number;
  }) => Promise<void>;
  updateSkipIntervals: (payload: { forwardMs: number; backwardMs: number }) => Promise<void>;
  available: () => Promise<boolean>;
  drainPendingEvents: () => Promise<string[]>;
  onEvent: (handler: (event: { type: string; positionMs?: number; offsetMs?: number }) => void) => Unsubscribe;
  notificationPermission: () => Promise<{ granted: boolean; required: boolean }>;
  requestNotificationPermission: () => Promise<{
    granted: boolean;
    required: boolean;
    requested: boolean;
  }>;
};

export interface NativePlayerBridge {
  player: PlayerBridge;
  mediaControls: MediaControlsBridge;
}

const unsupported = (_feature: string): Promise<never> =>
  Promise.reject(new Error('Android Media3 播放器不支持该高级音效能力'));

/**
 * 每个事件名已处理到的最大 `__seq`。
 *
 * ⚠️ 必须是模块级的：`setMediaSessionHandlers` 可能被注册不止一次，去重状态若放在
 * `listen()` 的闭包里，每个订阅会各自处理一遍同一事件 —— 实测一次按键跳两首。
 */
const lastSeqByEvent = new Map<string, number>();

const listen = (eventName: string, handler: (payload: any) => void): Unsubscribe => {
  let active = true;
  let handle: PluginListenerHandle | undefined;
  void NativePlayer.addListener(eventName, handler).then((registered) => {
    if (!active) {
      void registered.remove();
      return;
    }
    handle = registered;
  });

  /*
   * 备用通道：原生用 evaluateJavascript 直投的 CustomEvent。
   *
   * Capacitor 的原生→JS 事件走 WebMessageListener，实测 App 退到后台约 5 分钟后
   * 这条通道不再投递（evaluateJavascript 却一直可用）—— 表现为后台进度不更新、
   * 播完不切歌、按键无反应。两条通道会同时到达，按原生侧的单调 __seq 去重。
   */
  const onDirect = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { event?: string; data?: { __seq?: number } }
      | undefined;
    if (!detail || detail.event !== eventName) return;
    const seq = Number(detail.data?.__seq ?? 0);
    if (seq > 0) {
      const last = lastSeqByEvent.get(eventName) ?? 0;
      if (seq <= last) return;
      lastSeqByEvent.set(eventName, seq);
    }
    handler(detail.data);
  };
  window.addEventListener('hpp:native', onDirect);

  return () => {
    active = false;
    window.removeEventListener('hpp:native', onDirect);
    if (handle) void handle.remove();
  };
};

const createPlayer = (): PlayerBridge => {
  let notificationRequested = false;

  const ensureNotificationPermission = async () => {
    if (notificationRequested) return;
    notificationRequested = true;
    try {
      const state = await NativePlayer.notificationPermission();
      if (state.required && !state.granted) await NativePlayer.requestNotificationPermission();
    } catch {
      // 播放不应因通知权限拒绝而失败；系统可能仍允许本地媒体会话工作。
    }
  };

  /**
   * 最近一次淡入淡出"落在哪个音量"。
   *
   * ⚠️ 淡入是从 0 开始的：期间被取消（暂停 / 切歌）会把音量留在中间值。
   * 之后若走"不淡入"的播放路径，就会变成**状态在播放、却没有声音**。
   */
  let lastFadeVolume = 0;

  /**
   * 取消在途的淡入淡出。
   *
   * ⚠️ 现在斜坡由原生按 Handler 打步进（见 `setVolumeRamp`），所以这里
   * 只负责把音量落到目标值 —— 不落的话淡入被中途取消会留下半截音量。
   */
  const cancelFade = async (): Promise<void> => {
    await NativePlayer.setVolume({ volume: lastFadeVolume }).catch(() => undefined);
  };

  /**
   * 音量过渡。
   *
   * ⚠️ 必须交给原生做，**不能**在 JS 里用 setInterval 每 40ms 推一次音量：
   * 页面退到后台后 Chromium 把 setInterval 节流到约 1 次/分钟，一段 1 秒的淡入
   * 要跑几十分钟；而 `playTrack` 是 `await` 这次淡入的 —— 于是整条切歌链路挂住，
   * 表现为"后台按下一首没反应"。同一个坑之前还导致过"在播但没声音"。
   */
  const fade = async (from: number, to: number, durationMs: number): Promise<void> => {
    const start = Math.max(0, Math.min(100, Number(from) || 0));
    const target = Math.max(0, Math.min(100, Number(to) || 0));
    lastFadeVolume = target;
    console.info(`[TransportDiag] fade:start {"from":${start},"to":${target},"ms":${durationMs}}`);
    if (durationMs <= 0 || start === target) {
      await NativePlayer.setVolume({ volume: target });
      return;
    }
    // 原生按 Handler 打步进，不受 WebView 定时器节流影响；调用立即返回。
    await NativePlayer.setVolumeRamp({ from: start, to: target, durationMs });
  };

  return {
    beginSourceChange: async () => (await NativePlayer.beginSourceChange()).requestId,
    load: async (url, requestId) => NativePlayer.load({ url, requestId }),
    loadMkvTrack: async () => unsupported('MKV 多音轨选择'),
    switchSource: async () => unsupported('无缝换源'),
    play: async (requestId) => {
      await ensureNotificationPermission();
      await NativePlayer.play({ requestId });
    },
    pause: () => NativePlayer.pause(),
    stop: () => NativePlayer.stop(),
    seek: async (time) => NativePlayer.seek({ time }),
    setVolume: async (volume) => NativePlayer.setVolume({ volume }),
    debugLog: async (message) => {
      try {
        await NativePlayer.log({ message });
      } catch {
        // 诊断通道失败不能影响播放
      }
    },
    setSpeed: async (speed) => NativePlayer.setSpeed({ speed }),
    setLoopFile: async (loop) => NativePlayer.setLoopFile({ loop }),
    setPauseOnDeviceDisconnect: async (enabled) =>
      NativePlayer.setPauseOnDeviceDisconnect({ enabled }),
    setBackgroundNextSource: async (options) => NativePlayer.setBackgroundNextSource(options),
    clearBackgroundQueue: async (expectedItemCount = 1) => NativePlayer.clearBackgroundQueue({ expectedItemCount }),
    finishBackgroundQueue: async (generation, currentTrackId) => NativePlayer.finishBackgroundQueue({ generation, currentTrackId }),
    setBackgroundRepeatMode: async (mode) => NativePlayer.setBackgroundRepeatMode({ mode }),
    skipQueueTrack: async (direction) => (await NativePlayer.skipQueueTrack({ direction })).handled,
    setCoPlayWithOthers: async (enabled) => NativePlayer.setCoPlayWithOthers({ enabled }),
    drainPendingMediaControls: async () => (await NativePlayer.getPendingMediaControls()).events,
    getState: () => NativePlayer.getState(),
    available: async () => (await NativePlayer.available()).available,
    playWithFade: async (targetVolume, durationMs, requestId) => {
      console.info(
        `[TransportDiag] playWithFade {"target":${targetVolume},"ms":${durationMs}}`,
      );
      await NativePlayer.setVolume({ volume: 0 });
      await NativePlayer.play({ requestId });
      await fade(0, targetVolume, durationMs);
    },
    pauseWithFade: async (savedVolume, durationMs) => {
      // 整段交给原生：淡出 → 暂停 → 还原音量。分三步在 JS 里做的话，中间那个
      // await 依赖淡出完成，后台被节流时暂停会被拖到几十秒后才发生。
      await NativePlayer.pauseWithFade({ durationMs, restoreVolume: savedVolume });
    },
    fade,
    cancelFade,
    setEqualizer: async (gains: number[]) => {
      await NativePlayer.setEqualizer({ gains });
    },
    setAudioEffect: async (options) => {
      await NativePlayer.setAudioEffect(options ?? {});
    },
    setNormalizationGain: async (gainDb: number) => {
      await NativePlayer.setNormalizationGain({ gainDb });
    },
    // 以下能力 Android 侧没有对应物，一律保持空实现（且不要伪装成成功）：
    // - DSP Provider：独立音效引擎（.vpf 等），需要 provider 进程/授权，手机端不接入
    // - 音频图 / 输出设备：桌面端的 WASAPI/ASIO 独占输出概念，Android 走系统音频通道
    selectDspProvider: async () => null,
    listDspProviders: async () => [],
    inspectDspProvider: async () => null,
    getAudioGraph: async () => null,
    setAudioGraphParameter: async () => {},
    setAudioGraphPlan: async () => {},
    setAudioOutput: async () => {},
    getAudioDevices: async () => [],
    onTimeUpdate: (handler) => listen('timeUpdate', handler),
    onDurationChange: (handler) =>
      listen('durationChange', (payload: { duration: number }) => handler(payload.duration)),
    onSeeked: (handler) =>
      listen('seeked', (payload: { time: number }) => handler(payload.time)),
    onSeekStateChange: (handler) => listen('seekStateChange', handler),
    onStateChange: (handler) => listen('stateChange', handler),
    onPlaybackEnd: (handler) =>
      listen('playbackEnd', (payload: { reason: string } & PlaybackContext) =>
        handler(payload.reason, payload)),
    onError: (handler) => listen('error', handler),
  };
};

const createMediaControls = (): MediaControlsBridge => ({
  updateMetadata: (payload) => NativePlayer.updateMetadata(payload),
  updateState: (payload) => NativePlayer.updateState(payload),
  updateTimeline: (payload) => NativePlayer.updateTimeline(payload),
  updateSkipIntervals: (payload) => NativePlayer.updateSkipIntervals(payload),
  available: async () => (await NativePlayer.mediaControlsAvailable()).available,
  drainPendingEvents: async () => (await NativePlayer.getPendingMediaControls()).events,
  onEvent: (handler) => listen('mediaControl', handler),
  notificationPermission: () => NativePlayer.notificationPermission(),
  requestNotificationPermission: () => NativePlayer.requestNotificationPermission(),
});

/** 创建给主 agent 集成到 window.electron 的移动端实现。 */
export const createNativePlayerBridge = (): NativePlayerBridge => ({
  player: createPlayer(),
  mediaControls: createMediaControls(),
});

/** 可选的直接安装辅助；主 agent 也可以只使用 createNativePlayerBridge。 */
export const installNativePlayerBridge = (electron: {
  player?: unknown;
  mediaControls?: unknown;
}): NativePlayerBridge => {
  const bridge = createNativePlayerBridge();
  electron.player = bridge.player;
  electron.mediaControls = bridge.mediaControls;
  return bridge;
};
