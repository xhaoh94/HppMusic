/**
 * 让页面在后台不被 Chromium 冻结。
 *
 * 背景：声音在原生 ExoPlayer 里，页面本身是静音的。Chromium 会把“隐藏且静默”超过
 * 约 5 分钟的页面冻结 —— 定时器、Promise 解析、网络回调全部暂停，只有原生主动
 * evaluateJavascript 还能同步执行。取链走 HTTP，一冻结就永远等不到响应，表现为
 * “后台按键收到了但切不了歌”。
 *
 * 做法：后台挂一条 20Hz、增益 0.02 的振荡器。20Hz 低于人耳下限，但足以让 Chromium
 * 判定页面“正在出声”，从而跳过冻结。前台把增益归零。
 *
 * ⚠️ 别改成持有 Web Lock：Chromium 文档把它列为免冻结条件，但实现要求这把锁与
 * “其他非冻结页面”竞争，单页 WebView 持锁不算数 —— 实测后台 8 分钟照冻结。
 */

type DiagBridge = { log?: (payload: { message: string }) => Promise<void> };

const diag = (message: string): void => {
  try {
    const plugins = (window as unknown as { Capacitor?: { Plugins?: { EchoNativePlayer?: DiagBridge } } })
      .Capacitor?.Plugins;
    void plugins?.EchoNativePlayer?.log?.({ message: `keepalive:${message}` });
  } catch {
    // 诊断通道不可用时忽略
  }
};

/** 后台保活音量。0 会被判成“静音页”等于没做，再大就有可闻底噪的风险。 */
const KEEPALIVE_GAIN = 0.02;

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;

const ensureAudioGraph = (): void => {
  if (audioContext) return;
  const Ctor = window.AudioContext;
  if (!Ctor) return;
  try {
    audioContext = new Ctor();
    const oscillator = audioContext.createOscillator();
    gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    oscillator.frequency.value = 20;
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    diag(`graph state=${audioContext.state}`);
  } catch (error) {
    diag(`graph:failed ${String(error)}`);
  }
};

const setKeepAliveGain = (enabled: boolean): void => {
  if (!gainNode || !audioContext) return;
  const now = audioContext.currentTime;
  // 50ms 斜坡，避免增益硬切时扬声器“咔”一声。
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(enabled ? KEEPALIVE_GAIN : 0, now + 0.05);
  if (enabled) void audioContext.resume().catch(() => undefined);
};

export const installBackgroundAudioKeepAlive = (): void => {
  if (typeof window === 'undefined' || !window.AudioContext) return;

  // WebView 里没有用户手势也能建出 running 的上下文；万一被挂起，首次触摸补一次 resume。
  ensureAudioGraph();
  window.addEventListener(
    'pointerdown',
    () => void audioContext?.resume().catch(() => undefined),
    { once: true, passive: true },
  );

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    diag(`vis=${document.visibilityState} state=${audioContext?.state ?? 'none'}`);
    setKeepAliveGain(hidden);
  });
};
