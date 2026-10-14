/**
 * 听歌识曲适配层。
 *
 * 链路：**麦克风采集（16kHz 单声道 PCM）→ POST /audio/match → 匹配列表**。
 *
 * ## 好消息：采集与识别都不需要自己写
 *
 * · 采集：`src/bridge/deviceApis.ts` 的 `createRecognizeApi()` 已经用
 *   Web Audio（`getUserMedia` + `AudioContext({sampleRate:16000})` +
 *   `ScriptProcessor`）采出 PCM16 —— 这是从上游继承下来的，不用碰原生。
 * · 上传：内核 `api/recognize.ts` 的 `recognizeAudio(pcm: ArrayBuffer)`
 *   直接把 PCM 当请求体 POST 给 `/audio/match`。
 *
 * ## Android 上唯一的音源是麦克风
 *
 * 上游桌面端还有"系统内录"（抓本机正在播放的声音）这个音源，Android 没有对应物，
 * 桥接层会明确抛错。所以这里只调 `source: 'mic'`，并且不做音源选择入口 ——
 * 给一个永远失败的选项比不给更糟。
 *
 * ## 麦克风权限
 *
 * WebView 里 `getUserMedia` 的权限请求由 Capacitor 的 `BridgeWebChromeClient`
 * 代理（`onPermissionRequest` 里申请 RECORD_AUDIO + MODIFY_AUDIO_SETTINGS）。
 * ⚠️ 两个权限都必须在 AndroidManifest 里声明，少一个这次申请就会整体失败，
 * 表现为"系统权限弹窗根本不出现"。
 */
import { ref } from 'vue';
import { recognizeAudio } from '@/api/recognize';
import type { RecognizeMatch } from '@/utils/mappers';
import logger from '@/utils/logger';

/** 录音上限（秒）。上游也是 10 秒：指纹识别不需要更长，再长只是让用户等 */
export const MAX_RECORD_SECONDS = 10;

export type RecognizeStatus = 'idle' | 'recording' | 'recognizing' | 'done' | 'failed';

/**
 * 把采集结果归一化成 ArrayBuffer。
 *
 * `stopAudioCapture` 的类型声明是 `Promise<Uint8Array>`，而桥接层的实现返回的是
 * `Float32→PCM16` 后的 `.buffer`（ArrayBuffer）。两边的形状不一致，而
 * `recognizeAudio` 要的是 ArrayBuffer —— 所以在这里一次性抹平，
 * 而不是在调用处强转（强转在实现变化时会静默传错东西）。
 */
const toArrayBuffer = (value: unknown): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return new ArrayBuffer(0);
};

export const useRecognize = () => {
  const status = ref<RecognizeStatus>('idle');
  const seconds = ref(0);
  const matches = ref<RecognizeMatch[]>([]);
  const error = ref('');

  let timer: number | null = null;
  /** 代际：连点开始/停止、或离开页面时，旧流程的结果一律丢弃 */
  let generation = 0;

  const clearTimer = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  const isCurrent = (gen: number) => gen === generation;

  /** 把底层错误翻译成人话（原始信息基本是英文且不知道怎么处理） */
  const describeError = (caught: unknown): string => {
    const message = caught instanceof Error ? caught.message : String(caught);
    const normalized = message.toLowerCase();
    if (normalized.includes('permission') || normalized.includes('denied') || normalized.includes('权限')) {
      return '没有麦克风权限，请在系统设置里授予后再试';
    }
    if (normalized.includes('notfound') || normalized.includes('device')) {
      return '找不到可用的麦克风';
    }
    if (message.includes('系统内录')) return message;
    return message || '识别失败，请稍后重试';
  };

  const stop = async () => {
    if (status.value !== 'recording') return;
    const gen = generation;
    clearTimer();
    status.value = 'recognizing';
    try {
      const raw = await window.electron?.recognize?.stopAudioCapture?.();
      if (!isCurrent(gen)) return;
      const pcm = toArrayBuffer(raw);
      if (pcm.byteLength === 0) {
        throw new Error('没有采集到音频，请确认麦克风可用');
      }
      const result = await recognizeAudio(pcm);
      if (!isCurrent(gen)) return;
      matches.value = result;
      status.value = 'done';
      if (!result.length) error.value = '没有识别到匹配的歌曲，换个环境再试试';
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('Recognize', 'Stop/recognize failed', caught);
      error.value = describeError(caught);
      status.value = 'failed';
    }
  };

  const start = async () => {
    if (status.value === 'recording' || status.value === 'recognizing') return;
    const gen = ++generation;
    clearTimer();
    matches.value = [];
    error.value = '';
    seconds.value = 0;
    status.value = 'recording';

    try {
      const capture = await window.electron?.recognize?.startAudioCapture?.({
        // 只可能是麦克风：Android 没有系统内录
        source: 'mic',
      });
      if (!isCurrent(gen)) return;
      if (!capture?.running) throw new Error('麦克风启动失败');

      timer = window.setInterval(() => {
        if (!isCurrent(gen) || status.value !== 'recording') return;
        seconds.value += 1;
        if (seconds.value >= MAX_RECORD_SECONDS) void stop();
      }, 1000);
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('Recognize', 'Start capture failed', caught);
      error.value = describeError(caught);
      status.value = 'failed';
    }
  };

  /** 取消录音（不提交） */
  const cancel = () => {
    generation += 1;
    clearTimer();
    void window.electron?.recognize?.cancelAudioCapture?.();
    status.value = 'idle';
    seconds.value = 0;
  };

  const reset = () => {
    generation += 1;
    clearTimer();
    status.value = 'idle';
    seconds.value = 0;
    matches.value = [];
    error.value = '';
  };

  /** 离开页面时必须调：否则录音会一直开着（麦克风占用 + 耗电） */
  const dispose = () => {
    generation += 1;
    clearTimer();
    void window.electron?.recognize?.cancelAudioCapture?.();
  };

  return { status, seconds, matches, error, start, stop, cancel, reset, dispose };
};
