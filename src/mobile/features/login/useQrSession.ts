/**
 * 通用扫码登录会话。
 *
 * 酷狗 / QQ / 微信三种扫码登录的**轮询机制完全一样**，差别只在：
 * · 怎么拉二维码
 * · 怎么解释一次轮询的结果（各自的状态码含义完全不同）
 *
 * 所以这里把共性抽出来，各平台只提供一个 adapter（`load` + `poll` 两个方法）。
 * 手写三遍会必然出现"三个流程的超时/防竞态各不相同"这种问题 ——
 * 上游桌面端就是三份几乎重复的 while 循环（合计 150 行）。
 *
 * ## 共性里有三件必须做对的事
 *
 * 1. **代际（generation）防竞态**：切换方式、重新获取、卸载都会递增代际，
 *    异步回来时代际不符就丢弃。否则会出现"切走了还在轮询"、
 *    "旧二维码的响应把新二维码的状态改掉"。
 * 2. **会话归属检查**：每轮用内核 `captureUserSession` 确认登录态没被别人动过。
 *    轮询是长跑（约 2 分钟），期间用户可能在别处登录成功 ——
 *    不检查的话这边会把旧流程跑完并覆盖登录态。
 * 3. **单次失败不致命**：移动网络切换很常见，一次请求失败就终止轮询
 *    会让用户觉得"扫码没反应"，实际只是网络抖了一下。
 */
import { onBeforeUnmount, ref } from 'vue';
import { captureUserSession } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';

export type QrState =
  | 'idle'
  /** 正在获取二维码 */
  | 'loading'
  /** 二维码已就绪，等待扫码 */
  | 'waiting'
  /** 已扫码，等待确认 */
  | 'scanned'
  /** 二维码失效，需要重新获取 */
  | 'expired'
  | 'error'
  | 'success';

export type QrPollOutcome =
  | { kind: 'waiting' }
  | { kind: 'scanned'; message?: string }
  | { kind: 'expired'; message?: string }
  | { kind: 'error'; message: string }
  | { kind: 'success'; data: Record<string, unknown>; message?: string };

export interface QrAdapter {
  /** 平台名，只用于日志 */
  name: string;
  /** 拉一张新二维码，返回可直接喂给 `<img src>` 的字符串（data URL 或 http URL） */
  load: () => Promise<string>;
  /** 轮询一次并翻译成语义化结果 */
  poll: () => Promise<QrPollOutcome>;
}

/** 轮询间隔。上游桌面端用 3 秒；再密对上游不友好，再疏用户会觉得"扫了没反应" */
const POLL_INTERVAL_MS = 3000;
/** 单张二维码的最长轮询时长（上游二维码有效期约 2 分钟） */
const POLL_TIMEOUT_MS = 120_000;

export const useQrSession = (adapter: QrAdapter, onLoggedIn: () => void) => {
  const userStore = useUserStore();
  const ownsSession = captureUserSession(userStore);

  const state = ref<QrState>('idle');
  const imageUrl = ref('');
  /** 给用户看的一句话（"已扫码，请在手机上确认" / "二维码已过期"） */
  const message = ref('');
  const error = ref('');

  /** 代际：每次重新获取 / 停止 都递增 */
  let generation = 0;
  let pollTimer: number | null = null;
  let deadline = 0;
  let disposed = false;

  const clearPoll = () => {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const stop = () => {
    generation += 1;
    clearPoll();
    if (state.value !== 'success') state.value = 'idle';
  };

  const isCurrent = (gen: number) => !disposed && gen === generation && ownsSession();

  const scheduleNextPoll = (gen: number) => {
    if (!isCurrent(gen)) return;
    if (Date.now() >= deadline) {
      state.value = 'expired';
      message.value = '二维码已过期';
      return;
    }
    clearPoll();
    pollTimer = window.setTimeout(() => void poll(gen), POLL_INTERVAL_MS);
  };

  const poll = async (gen: number) => {
    if (!isCurrent(gen)) return;
    try {
      const outcome = await adapter.poll();
      if (!isCurrent(gen)) return;

      switch (outcome.kind) {
        case 'success': {
          state.value = 'success';
          stop();
          userStore.login(outcome.data);
          onLoggedIn();
          return;
        }
        case 'scanned':
          state.value = 'scanned';
          message.value = outcome.message || '已扫码，请在设备上确认';
          break;
        case 'expired':
          // 失效后不自动重试：自动重试会让"我明明没扫，二维码却一直在变"出现
          state.value = 'expired';
          message.value = outcome.message || '二维码已过期';
          stop();
          return;
        case 'error':
          // 平台明确回报的错误（如"扫码状态异常"）不该继续轮询
          state.value = 'error';
          error.value = outcome.message;
          stop();
          return;
        default:
          state.value = 'waiting';
          break;
      }
      scheduleNextPoll(gen);
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('QrSession', `${adapter.name} poll failed`, caught);
      // 单次网络失败不当作致命：继续轮询
      scheduleNextPoll(gen);
    }
  };

  /** 重新拉一张二维码并开始轮询 */
  const reload = async () => {
    stop();
    const gen = ++generation;
    state.value = 'loading';
    error.value = '';
    message.value = '';
    imageUrl.value = '';

    try {
      const image = await adapter.load();
      if (!isCurrent(gen)) return;
      if (!image) throw new Error('二维码生成失败，请稍后重试');
      imageUrl.value = image;
      state.value = 'waiting';
      deadline = Date.now() + POLL_TIMEOUT_MS;
      scheduleNextPoll(gen);
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('QrSession', `${adapter.name} load failed`, caught);
      error.value = caught instanceof Error ? caught.message : String(caught);
      state.value = 'error';
      stop();
    }
  };

  /**
   * 方式被激活时调。
   *
   * 已有**有效**二维码就只恢复轮询（不重新拉码）—— 用户来回切方式时
   * 二维码不停变会让人以为"码一直在刷新，我扫的是哪一张"。
   */
  const activate = () => {
    const usable =
      Boolean(imageUrl.value) && state.value !== 'expired' && state.value !== 'error';
    if (!usable) {
      void reload();
      return;
    }
    const gen = ++generation;
    state.value = state.value === 'scanned' ? 'scanned' : 'waiting';
    scheduleNextPoll(gen);
  };

  onBeforeUnmount(() => {
    disposed = true;
    stop();
  });

  return { state, imageUrl, message, error, reload, activate, stop };
};

export type QrSession = ReturnType<typeof useQrSession>;
