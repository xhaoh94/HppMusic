/**
 * 三个平台的扫码 adapter。
 *
 * 每个平台的**状态码含义完全不同**，全部在这一层翻译成语义化结果，
 * 上层（`useQrSession`）只认 `waiting/scanned/expired/error/success` 五种。
 *
 * 这样做的收益很直接：状态码是上游最容易变、也最容易理解错的东西，
 * 把它们关在这一个文件里，改起来不用碰轮询逻辑。
 */
import {
  checkLoginQr,
  checkQqLoginQr,
  checkWxLogin,
  createLoginQr,
  createQqLoginQr,
  createWxLogin,
  getLoginQrKey,
  loginByOpenPlat,
  type QqLoginQrSession,
} from '@/api/user';
import type { QrAdapter, QrPollOutcome } from './useQrSession';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asData = (value: unknown): Record<string, unknown> | null => asRecord(asRecord(value)?.data);

/* ────────────────────────────────────────────────────────────
   酷狗（概念版扫码）
   ──────────────────────────────────────────────────────────── */

/**
 * 状态码（`data.status`，注意不是响应体的 status）：
 * · 1 / 3 → 等待扫码
 * · 2     → 已扫码，等待手机上确认
 * · 4     → 登录成功，`data` 里带 token
 * · 0     → 已失效
 */
export const createKugouQrAdapter = (): QrAdapter => {
  let key = '';

  return {
    name: 'kugou',
    load: async () => {
      const keyResponse: any = await getLoginQrKey();
      const nextKey = keyResponse?.data?.qrcode || keyResponse?.data?.key;
      if (Number(keyResponse?.status) !== 1 || !nextKey) {
        throw new Error('获取二维码失败，请稍后重试');
      }
      key = String(nextKey);

      // 上游有时在 key 接口就带图片，有时要单独 create 一次
      const inlineImage = String(keyResponse?.data?.qrcode_img ?? '');
      if (inlineImage) return inlineImage;

      const createResponse: any = await createLoginQr(key);
      const image = String(createResponse?.data?.qrcode_img ?? '');
      if (Number(createResponse?.status) !== 1 || !image) {
        throw new Error('二维码生成失败，请稍后重试');
      }
      return image;
    },
    poll: async (): Promise<QrPollOutcome> => {
      const response: any = await checkLoginQr(key);
      const status = Number(asData(response)?.status ?? asRecord(response)?.status);
      if (status === 4) {
        const data = asData(response);
        if (data) return { kind: 'success', data };
        // status=4 但没带 data：上游偶发抖动，继续轮询而不是直接失败
        return { kind: 'waiting' };
      }
      if (status === 2) return { kind: 'scanned', message: '已扫码，请在设备上确认' };
      if (status === 0) return { kind: 'expired' };
      return { kind: 'waiting' };
    },
  };
};

/* ────────────────────────────────────────────────────────────
   QQ
   ──────────────────────────────────────────────────────────── */

const parseQqSession = (response: unknown): QqLoginQrSession | null => {
  const record = asRecord(response);
  if (!record) return null;
  const stringFields = ['cookie', 'qrsig', 'pt_login_sig', 'pt_openlogin_data', 'xlogin_url'];
  if (stringFields.some((field) => typeof record[field] !== 'string' || !record[field])) {
    return null;
  }
  if (
    (typeof record.ptqrtoken !== 'string' && typeof record.ptqrtoken !== 'number') ||
    !String(record.ptqrtoken)
  ) {
    return null;
  }
  return {
    cookie: String(record.cookie),
    qrsig: String(record.qrsig),
    ptqrtoken: record.ptqrtoken as string | number,
    pt_login_sig: String(record.pt_login_sig),
    pt_openlogin_data: String(record.pt_openlogin_data),
    xlogin_url: String(record.xlogin_url),
  };
};

/**
 * 状态码是**字符串**，与酷狗的数字状态码完全不同：
 * · `wait` / `66`    → 等待扫码
 * · `67`             → 已扫码，等待 QQ 里确认
 * · `expired` / `65` → 已过期
 * · `status === 1 && data.token` → 登录成功
 */
export const createQqQrAdapter = (): QrAdapter => {
  let session: QqLoginQrSession | null = null;

  return {
    name: 'qq',
    load: async () => {
      const response: any = await createQqLoginQr();
      const parsed = parseQqSession(response);
      const qrcode = typeof response?.qrcode === 'string' ? response.qrcode : '';
      if (!parsed || !qrcode) throw new Error('QQ 二维码加载失败，请稍后重试');
      session = parsed;
      // QQ 返回的是裸 base64，要自己拼 data URL（酷狗返回的已经带前缀）
      return qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode}`;
    },
    poll: async (): Promise<QrPollOutcome> => {
      if (!session) return { kind: 'error', message: 'QQ 登录会话已失效，请重新获取二维码' };
      const response: any = await checkQqLoginQr(session);

      if (Number(response?.status) === 1 && response?.data?.token) {
        const data = asRecord(response.data);
        if (data) return { kind: 'success', data };
      }

      const status = String(response?.status ?? '');
      const message = typeof response?.msg === 'string' ? response.msg : '';
      if (status === 'wait' || status === '66') return { kind: 'waiting' };
      if (status === '67') return { kind: 'scanned', message: message || '已扫码，请在 QQ 中确认' };
      if (status === 'expired' || status === '65') {
        return { kind: 'expired', message: message || '二维码已过期' };
      }
      return { kind: 'error', message: message || 'QQ 扫码状态异常，请重新加载' };
    },
  };
};

/* ────────────────────────────────────────────────────────────
   微信
   ──────────────────────────────────────────────────────────── */

/**
 * 状态码（`wx_errcode`，数字，但语义与酷狗也完全不同）：
 * · `408` → 等待扫码
 * · `404` → 已扫码，等待确认
 * · `405` → **扫码+确认完成**，拿到 `wx_code` 后还要再换一次登录态（`loginByOpenPlat`）
 * · `403` / `402` → 失效或被拒绝
 *
 * ⚠️ 微信比其他两个多一步：405 只是"授权完成"，真正的登录态要拿
 * `wx_code` 去 `loginByOpenPlat` 换。这一步放在 adapter 里，
 * 这样上层仍是统一的"一次 poll 出 success 还是没出"。
 */
export const createWxQrAdapter = (): QrAdapter => {
  let uuid = '';

  return {
    name: 'wechat',
    load: async () => {
      const response: any = await createWxLogin();
      uuid = typeof response?.uuid === 'string' ? response.uuid : '';
      const base64 = typeof response?.qrcode?.qrcodebase64 === 'string'
        ? response.qrcode.qrcodebase64
        : '';
      const remoteUrl = typeof response?.qrcode?.qrcodeurl === 'string'
        ? response.qrcode.qrcodeurl
        : '';
      if (!uuid) throw new Error('微信二维码加载失败，请稍后重试');
      if (!base64 && !remoteUrl) throw new Error('微信二维码加载失败，请稍后重试');
      // 微信的 base64 是 jpeg（与其他两家的 png 不同）
      return base64
        ? base64.startsWith('data:')
          ? base64
          : `data:image/jpeg;base64,${base64}`
        : remoteUrl;
    },
    poll: async (): Promise<QrPollOutcome> => {
      if (!uuid) return { kind: 'error', message: '微信登录会话已失效，请重新获取二维码' };
      const response: any = await checkWxLogin(uuid, Date.now());
      const code = Number(response?.wx_errcode ?? response?.status);

      if (code === 408) return { kind: 'waiting' };
      if (code === 404) return { kind: 'scanned', message: '已扫码，请在微信中确认' };

      if (code === 405) {
        const wxCode = typeof response?.wx_code === 'string' ? response.wx_code : '';
        if (!wxCode) return { kind: 'error', message: '微信授权信息缺失，请重试' };

        const loginResponse: any = await loginByOpenPlat(wxCode);
        const data = asRecord(loginResponse?.data) ?? asRecord(loginResponse?.body?.data);
        if (Number(loginResponse?.status) === 1 || Number(loginResponse?.code) === 200) {
          if (data) return { kind: 'success', data };
          return { kind: 'error', message: '微信登录返回数据异常，请重试' };
        }
        return {
          kind: 'error',
          message: loginResponse?.msg || loginResponse?.message || '微信登录失败，请重试',
        };
      }

      if (code === 403 || code === 402) return { kind: 'expired', message: '二维码已失效' };
      return { kind: 'waiting' };
    },
  };
};
