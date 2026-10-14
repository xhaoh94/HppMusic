/**
 * 酷狗扫码登录。
 *
 * 手机上没有第二台设备就扫不了码，所以短信验证码是保底方式；但对于有两台设备
 * （或用平板/备用机）的人，扫码比每次等短信省事得多 —— 这里把两种方式都给出。
 *
 * ## 状态码语义（来自上游接口，必须严格按这个判断）
 *
 * `checkLoginQr(key)` 返回的 `data.status`：
 * · `1` / `3` → 二维码已生成，**等待扫码**
 * · `2`      → **已扫码，等待手机上确认**
 * · `4`      → **登录成功**，`data` 里带 token
 * · `0`      → 二维码**已失效**（超时或已被取消），需要重新获取
 *
 * ⚠️ 注意区分 `data.status` 与响应体的 `status`：前者是二维码状态，
 * 后者是接口调用状态。上游代码里写的是 `res.data?.status ?? res.status`，
 * 只在 data 缺失时才回退 —— 直接取 `res.status` 会把"接口成功(1)"当成
 * 二维码状态，界面就永远停在"等待扫码"。
 *
 * ## 为什么要做会话归属检查
 *
 * 轮询是长跑（最长约 2 分钟）的异步循环，期间用户可能：切到别的登录方式、
 * 直接退出、或在别处登录成功。`captureUserSession` 是内核提供的会话快照比较器，
 * 轮询的每一轮都确认"现在这个会话还是我发起的那一个"，否则立刻停 ——
 * 不然会出现"用户在别处登录成功后，这边又把旧流程跑完并覆盖登录态"。
 */
import { onBeforeUnmount, ref } from 'vue';
import { checkLoginQr, createLoginQr, getLoginQrKey } from '@/api/user';
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

/** 轮询间隔。上游桌面端用 3 秒；再密对上游不友好，再疏用户会觉得"扫了没反应" */
const POLL_INTERVAL_MS = 3000;
/** 单张二维码的最长轮询时长（上游二维码有效期约 2 分钟） */
const POLL_TIMEOUT_MS = 120_000;

export const useQrLogin = (onLoggedIn: () => void) => {
  const userStore = useUserStore();
  /** 会话快照比较器：每次轮询前确认登录态没被别人动过 */
  const ownsSession = captureUserSession(userStore);

  const state = ref<QrState>('idle');
  const imageUrl = ref('');
  const error = ref('');

  let qrKey = '';
  /** 代际：每次重新获取/停止都递增，异步回来时代际不符就丢弃 */
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
    qrKey = '';
    // 状态也一并重置：不停轮询但保留 'waiting' 的话，外部（切方式/卸载）
    // 看到的内部状态与实际行为不一致，以后加逻辑很容易被这个坑到。
    if (state.value !== 'success') state.value = 'idle';
  };

  const isCurrent = (gen: number) => !disposed && gen === generation && ownsSession();

  const readStatus = (payload: unknown): number => {
    const record = payload as Record<string, unknown> | null;
    const data = record?.data as Record<string, unknown> | undefined;
    const raw = data?.status ?? record?.status;
    const status = Number(raw);
    return Number.isFinite(status) ? status : -1;
  };

  const scheduleNextPoll = (gen: number) => {
    if (!isCurrent(gen)) return;
    if (Date.now() >= deadline) {
      state.value = 'expired';
      return;
    }
    clearPoll();
    pollTimer = window.setTimeout(() => void poll(gen), POLL_INTERVAL_MS);
  };

  const poll = async (gen: number) => {
    if (!isCurrent(gen) || !qrKey) return;
    try {
      const response = await checkLoginQr(qrKey);
      if (!isCurrent(gen)) return;

      const status = readStatus(response);
      if (status === 4) {
        const data = (response as { data?: Record<string, unknown> })?.data;
        if (data) {
          state.value = 'success';
          stop();
          userStore.login(data);
          onLoggedIn();
          return;
        }
        // status=4 但没有 data：上游偶发抖动，继续轮询而不是直接失败
        logger.warn('QrLogin', 'QR status=4 but payload has no data');
      } else if (status === 2) {
        state.value = 'scanned';
      } else if (status === 0) {
        // 失效（超时/被取消）：让用户点一下重新获取，不自动重试 ——
        // 自动重试会让"我明明没扫，二维码却一直在变"这种困惑出现
        state.value = 'expired';
        stop();
        return;
      } else {
        state.value = 'waiting';
      }
      scheduleNextPoll(gen);
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('QrLogin', 'Poll QR status failed', caught);
      error.value = caught instanceof Error ? caught.message : String(caught);
      // 单次网络失败不当作致命：继续轮询（移动网络切换很常见）
      scheduleNextPoll(gen);
    }
  };

  /** 获取（或重新获取）二维码并开始轮询 */
  const load = async () => {
    stop();
    const gen = ++generation;
    state.value = 'loading';
    error.value = '';
    imageUrl.value = '';

    try {
      const keyResponse: any = await getLoginQrKey();
      if (!isCurrent(gen)) return;
      const key = keyResponse?.data?.qrcode || keyResponse?.data?.key;
      if (Number(keyResponse?.status) !== 1 || !key) {
        throw new Error('获取二维码失败，请稍后重试');
      }
      qrKey = String(key);

      // 上游有时在 key 接口就带图片，有时要单独 create 一次
      let image = String(keyResponse?.data?.qrcode_img ?? '');
      if (!image) {
        const createResponse: any = await createLoginQr(qrKey);
        if (!isCurrent(gen)) return;
        if (Number(createResponse?.status) !== 1 || !createResponse?.data?.qrcode_img) {
          throw new Error('二维码生成失败，请稍后重试');
        }
        image = String(createResponse.data.qrcode_img);
      }

      imageUrl.value = image;
      state.value = 'waiting';
      deadline = Date.now() + POLL_TIMEOUT_MS;
      scheduleNextPoll(gen);
    } catch (caught) {
      if (!isCurrent(gen)) return;
      logger.warn('QrLogin', 'Load QR failed', caught);
      error.value = caught instanceof Error ? caught.message : String(caught);
      state.value = 'error';
      stop();
    }
  };

  onBeforeUnmount(() => {
    disposed = true;
    stop();
  });

  return { state, imageUrl, error, load, stop };
};
