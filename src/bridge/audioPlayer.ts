/**
 * `window.electron.player` 的移动端实现。
 *
 * 桌面端这块背后是 Rust 原生音频引擎（WASAPI/ALSA/CoreAudio + DSP/淡入淡出/无缝过渡），
 * 安卓上不存在，所以这里用 HTML5 `<audio>` 顶上，只实现「能放能停能拖能报进度」这层语义。
 *
 * 契约对齐 src/renderer/utils/player.ts 里的 PlayerEngine —— 它调用时大量使用 `?.`，
 * 缺失的方法会自然降级；但下面这几个是**不带 `?.` 直接调**的，必须提供：
 * onTimeUpdate / onSeeked / onDurationChange / onStateChange / onPlaybackEnd / onError。
 *
 * 刻意不实现（避免给出错误的"支持"假象）：
 * - getTrackList / loadMkvTrack（MKV 多音轨，桌面原生才做）
 * - DSP / 均衡器 / 音频图 / 音频设备枚举
 * - onStall（卡死检测）：误报会触发上层的重载兜底，宁可不报
 * - onFileLoaded：上层在 load() resolve 后自己会 emit，我们再发一次会重复
 */
import './polyfills';

interface PlaybackContext {
  trackSeq?: number;
  generation?: number;
  sampledAt?: number;
}

type Unsubscribe = () => void;

const DEFAULT_VOLUME = 100;

export class MobileAudioPlayer {
  private readonly audio: HTMLAudioElement;

  /** 与桌面端 `player:*` 的 requestId 语义一致，由 beginSourceChange 下发、load 回传。 */
  private requestSeq = 0;
  private sourceSeq = 0;
  private generation = 0;

  private volumeValue = DEFAULT_VOLUME;
  private speedValue = 1;
  private playing = false;
  private pendingUrl = '';

  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.volume = this.volumeValue / 100;

    this.audio.addEventListener('timeupdate', () => {
      this.emit('time', {
        time: this.audio.currentTime,
        trackSeq: this.sourceSeq,
        generation: this.generation,
        sampledAt: Date.now(),
      });
    });

    this.audio.addEventListener('durationchange', () => {
      const duration = this.duration;
      if (duration > 0) this.emit('duration', duration);
    });

    this.audio.addEventListener('play', () => {
      this.playing = true;
      this.emitState();
    });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
      this.emitState();
    });

    this.audio.addEventListener('seeked', () => {
      this.emit('seeked', this.audio.currentTime);
    });

    this.audio.addEventListener('ended', () => {
      this.playing = false;
      this.emit('end', 'eof', this.context());
      this.emitState();
    });

    this.audio.addEventListener('error', () => {
      const code = this.audio.error?.code;
      const message =
        this.audio.error?.message ||
        (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? '音频地址不可用或格式不支持'
          : '音频加载失败');
      this.emit('error', { message, errorCode: String(code ?? ''), reason: 'media-element' });
    });
  }

  // ── 事件总线（on* 返回退订函数，与 preload 的 ipcRenderer.on 语义一致）──

  private on(name: string, handler: (...args: never[]) => void): Unsubscribe {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private emit(name: string, ...args: unknown[]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const handler of set) (handler as (...a: unknown[]) => void)(...args);
  }

  private context(): PlaybackContext {
    return {
      trackSeq: this.sourceSeq,
      generation: this.generation,
      sampledAt: Date.now(),
    };
  }

  private emitState(): void {
    this.emit('state', {
      playing: this.playing && !this.audio.paused,
      paused: !this.playing || this.audio.paused,
      trackSeq: this.sourceSeq,
      generation: this.generation,
      timePos: this.audio.currentTime,
      sampledAt: Date.now(),
    });
  }

  // ── getter ──

  get duration(): number {
    const value = this.audio.duration;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  // ── 播放命令 ──

  async available(): Promise<boolean> {
    return typeof Audio !== 'undefined';
  }

  async beginSourceChange(): Promise<number> {
    ++this.generation;
    this.pendingUrl = '';
    this.playing = false;
    this.audio.pause();
    return ++this.requestSeq;
  }

  async load(url: string, requestId?: number): Promise<{ duration: number; seq: number }> {
    if (requestId !== undefined && requestId !== this.requestSeq) {
      throw new Error('Audio source load was superseded');
    }
    this.pendingUrl = url;
    const seq = ++this.sourceSeq;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', onLoaded);
        this.audio.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(this.audio.error?.message || '音频加载失败'));
      };
      this.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.audio.addEventListener('error', onError, { once: true });
      // 换源必须走 load()，否则已锁定的旧 src 不会重新解析
      this.audio.src = url;
      this.audio.load();
    });

    return { duration: this.duration, seq };
  }

  async play(): Promise<void> {
    await this.audio.play();
    this.playing = true;
  }

  async pause(): Promise<void> {
    this.audio.pause();
    this.playing = false;
  }

  async stop(): Promise<void> {
    this.audio.pause();
    this.playing = false;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.pendingUrl = '';
  }

  async seek(time: number): Promise<void> {
    if (!Number.isFinite(time)) return;
    this.audio.currentTime = Math.max(0, time);
  }

  async setVolume(volume: number): Promise<void> {
    this.volumeValue = Math.min(100, Math.max(0, Number(volume) || 0));
    this.audio.volume = this.volumeValue / 100;
  }

  async setSpeed(speed: number): Promise<void> {
    this.speedValue = Math.min(5, Math.max(0.1, Number(speed) || 1));
    this.audio.playbackRate = this.speedValue;
  }

  async setLoopFile(loop: boolean): Promise<void> {
    this.audio.loop = Boolean(loop);
  }

  /** 桌面端是「按设备断开暂停」的原生能力，移动端没有对应语义。 */
  async setPauseOnDeviceDisconnect(): Promise<void> {}

  async getState(): Promise<{
    playing: boolean;
    paused: boolean;
    ended?: boolean;
    duration: number;
    timePos: number;
    trackSeq: number;
    generation: number;
    volume: number;
    sampledAt: number;
  }> {
    return {
      playing: !this.audio.paused,
      paused: this.audio.paused,
      ended: this.audio.ended,
      duration: this.duration,
      timePos: this.audio.currentTime,
      trackSeq: this.sourceSeq,
      generation: this.generation,
      volume: this.volumeValue,
      sampledAt: Date.now(),
    };
  }

  async getTrackList(): Promise<never[]> {
    return [];
  }

  async getAudioDevices(): Promise<never[]> {
    return [];
  }

  // ── 淡入淡出 ──
  //
  // 桌面端是原生侧的增益斜坡；HTML5 没有等价能力，用定时器插值音量近似。
  // 注意 utils/player.ts 会 `await` 这些方法，所以必须真的等斜坡走完。

  private fadeTimer: ReturnType<typeof setInterval> | null = null;

  private async runFade(from: number, to: number, durationMs: number): Promise<void> {
    const target = Math.min(100, Math.max(0, Number(to) || 0));
    const start = Math.min(100, Math.max(0, Number.isFinite(from) ? from : this.volumeValue));
    if (this.fadeTimer != null) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (durationMs <= 0 || start === target) {
      await this.setVolume(target);
      return;
    }
    const steps = Math.max(1, Math.round(durationMs / 40));
    let done = 0;
    await new Promise<void>((resolve) => {
      this.fadeTimer = setInterval(() => {
        done += 1;
        const ratio = Math.min(1, done / steps);
        void this.setVolume(start + (target - start) * ratio);
        if (ratio >= 1) {
          if (this.fadeTimer != null) clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          resolve();
        }
      }, 40);
    });
  }

  async playWithFade(targetVolume: number, durationMs: number, requestId?: number): Promise<void> {
    if (requestId !== undefined && requestId !== this.requestSeq) return;
    await this.play();
    await this.runFade(0, targetVolume, durationMs);
  }

  async pauseWithFade(savedVolume: number, durationMs: number): Promise<void> {
    await this.runFade(this.volumeValue, 0, durationMs);
    await this.pause();
    // 淡出后把音量留给下一次播放，上层用 savedVolume 决定恢复值
    await this.setVolume(savedVolume);
  }

  async fade(from: number, to: number, durationMs: number): Promise<void> {
    await this.runFade(from, to, durationMs);
  }

  async cancelFade(): Promise<void> {
    if (this.fadeTimer == null) return;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
  }

  // ── 不支持但必须存在的方法 ──
  //
  // utils/player.ts 用的是 `player?.setEqualizer(...)` —— `?.` 只防「对象不存在」，
  // **不防「方法缺失」**。所以这些在播放路径上会被调到的音效类方法必须给出来
  // （返回空实现即可），否则报 `player?.setEqualizer is not a function` 并中断整条链路。
  // HTML5 没有 DSP/均衡器/音频图，返回 resolved 的空命令即可 —— 上层会当成"设置成功"。

  async setEqualizer(): Promise<void> {}
  async setAudioEffect(): Promise<void> {}
  async setNormalizationGain(): Promise<void> {}
  async selectDspProvider(): Promise<null> {
    return null;
  }
  async listDspProviders(): Promise<never[]> {
    return [];
  }
  async inspectDspProvider(): Promise<null> {
    return null;
  }
  async getAudioGraph(): Promise<null> {
    return null;
  }
  async setAudioGraphParameter(): Promise<void> {}
  async setAudioGraphPlan(): Promise<void> {}
  async setAudioOutput(): Promise<void> {}

  // ── 事件订阅 ──

  onTimeUpdate(handler: (payload: { time: number } & PlaybackContext) => void): Unsubscribe {
    return this.on('time', handler as (...args: never[]) => void);
  }

  onDurationChange(handler: (duration: number) => void): Unsubscribe {
    return this.on('duration', handler as (...args: never[]) => void);
  }

  onSeeked(handler: (time: number) => void): Unsubscribe {
    return this.on('seeked', handler as (...args: never[]) => void);
  }

  onStateChange(
    handler: (state: {
      playing: boolean;
      paused: boolean;
      timePos: number;
      trackSeq: number;
      generation: number;
      sampledAt: number;
    }) => void,
  ): Unsubscribe {
    return this.on('state', handler as (...args: never[]) => void);
  }

  onPlaybackEnd(handler: (reason: string, context?: PlaybackContext) => void): Unsubscribe {
    return this.on('end', handler as (...args: never[]) => void);
  }

  onError(handler: (payload: { message: string }) => void): Unsubscribe {
    return this.on('error', handler as (...args: never[]) => void);
  }
}

export const createMobileAudioPlayer = (): MobileAudioPlayer => new MobileAudioPlayer();
