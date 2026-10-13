/**
 * 短信验证码登录。
 *
 * 刻意做成 composable 而不是塞进页面：登录页只负责画界面，状态机在这里，
 * 以后要做「手机号一键登录」「账号密码登录」「扫码登录」都在同一层追加，
 * 页面不需要跟着膨胀（桌面那个 Login.vue 就是四套流程挤在一个文件里，
 * 1500 行，改一处要读全篇）。
 *
 * ⚠️ token 落库全靠 `userStore.login(data)`：它会做字段映射、写入当前账号、
 * 记入「已保存账号」并触发资料拉取。**不要**绕过它自己拼 state，
 * 否则重启后 isLoggedIn 恢复不出来（那是移动端最容易被忽略的一类 bug）。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { loginBySms, sendSmsCode } from '@/api/user';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';

export interface SmsAccountCandidate {
  userid: number;
  nickname: string;
  pic?: string;
}

/** 上游「一个手机号下有多个账号」用的业务错误码 */
const MULTI_ACCOUNT_ERROR_CODE = 34175;
const MOBILE_PATTERN = /^1\d{10}$/;
const COUNTDOWN_SECONDS = 60;

const getResponseBody = (error: unknown): Record<string, unknown> | null => {
  if (!error || typeof error !== 'object') return null;
  const body = (error as { response?: { body?: unknown } }).response?.body;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
};

const readMessage = (source: unknown, fallback: string): string => {
  if (!source || typeof source !== 'object') return fallback;
  const record = source as Record<string, unknown>;
  const raw = record.error ?? record.message ?? record.msg;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text || fallback;
};

const extractAccountCandidates = (payload: unknown): SmsAccountCandidate[] => {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!record || Number(record.error_code) !== MULTI_ACCOUNT_ERROR_CODE) return [];
  const list = (record.data as { info_list?: unknown } | undefined)?.info_list;
  if (!Array.isArray(list)) return [];

  return list
    .map((item): SmsAccountCandidate | null => {
      const account =
        item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      const userid = Number(account?.userid);
      if (!Number.isFinite(userid) || userid <= 0) return null;
      return {
        userid,
        nickname: String(account?.nickname || account?.username || userid),
        pic: account?.pic ? String(account.pic) : undefined,
      };
    })
    .filter((item): item is SmsAccountCandidate => Boolean(item));
};

export const useSmsLogin = (onLoggedIn: () => void) => {
  const userStore = useUserStore();

  const mobile = ref('');
  const code = ref('');
  const error = ref('');
  const sending = ref(false);
  const submitting = ref(false);
  const countdown = ref(0);
  const accountCandidates = ref<SmsAccountCandidate[]>([]);
  /** 多账号选择时的加载态，用于把 spinner 只打在选中的那一行上 */
  const pendingUserid = ref<number | null>(null);

  let timer: number | null = null;

  const stopCountdown = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  onBeforeUnmount(stopCountdown);

  const startCountdown = () => {
    stopCountdown();
    countdown.value = COUNTDOWN_SECONDS;
    timer = window.setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0) stopCountdown();
    }, 1000);
  };

  const canSendCode = computed(
    () => !sending.value && countdown.value <= 0 && MOBILE_PATTERN.test(mobile.value.trim()),
  );
  const canSubmit = computed(
    () => !submitting.value && MOBILE_PATTERN.test(mobile.value.trim()) && code.value.trim().length > 0,
  );

  const resetCandidates = () => {
    accountCandidates.value = [];
    pendingUserid.value = null;
  };

  const completeLogin = (data: Record<string, unknown>) => {
    userStore.login(data);
    stopCountdown();
    onLoggedIn();
  };

  /**
   * 统一解释登录响应。
   * 返回 true 表示「这次调用已经把结果处理完了」（登录成功、或需要用户选账号），
   * 调用方不需要再报错。
   */
  const resolveLoginResponse = (payload: unknown): boolean => {
    if (!payload || typeof payload !== 'object') {
      error.value = '登录失败，请稍后重试';
      return false;
    }

    const candidates = extractAccountCandidates(payload);
    if (candidates.length) {
      accountCandidates.value = candidates;
      error.value = '';
      return true;
    }

    const record = payload as Record<string, any>;
    if (Number(record.status) === 1 && record.data?.token) {
      completeLogin(record.data as Record<string, unknown>);
      return true;
    }

    error.value = readMessage(payload, '登录失败，请稍后重试');
    return false;
  };

  const sendCode = async () => {
    if (!canSendCode.value) {
      if (!MOBILE_PATTERN.test(mobile.value.trim())) error.value = '请输入正确的手机号';
      return;
    }
    resetCandidates();
    sending.value = true;
    error.value = '';
    try {
      const response: any = await sendSmsCode(mobile.value.trim());
      if (Number(response?.status) === 1) startCountdown();
      else error.value = readMessage(response, '发送验证码失败，请稍后重试');
    } catch (caught) {
      logger.warn('Login', 'sendSmsCode failed', caught);
      error.value = readMessage(getResponseBody(caught), '发送验证码失败，请稍后重试');
    } finally {
      sending.value = false;
    }
  };

  const submit = async (userid?: number) => {
    if (!MOBILE_PATTERN.test(mobile.value.trim())) {
      error.value = '请输入正确的手机号';
      return;
    }
    if (!code.value.trim()) {
      error.value = '请输入验证码';
      return;
    }
    if (submitting.value) return;

    if (userid === undefined) resetCandidates();
    submitting.value = true;
    pendingUserid.value = userid ?? null;
    error.value = '';
    try {
      const response: any = await loginBySms(mobile.value.trim(), code.value.trim(), userid);
      resolveLoginResponse(response);
    } catch (caught) {
      logger.warn('Login', 'loginBySms failed', caught);
      // 上游把业务错误包在 502 的 body 里抛出，必须把它当正常响应再解释一遍，
      // 否则「一个手机号多个账号」这种情况会被当成网络错误（桌面端踩过）
      const handled = resolveLoginResponse(getResponseBody(caught));
      if (!handled && !accountCandidates.value.length) {
        error.value = readMessage(getResponseBody(caught), '登录失败，请稍后重试');
      }
    } finally {
      submitting.value = false;
      pendingUserid.value = null;
    }
  };

  return {
    mobile,
    code,
    error,
    sending,
    submitting,
    countdown,
    accountCandidates,
    pendingUserid,
    canSendCode,
    canSubmit,
    sendCode,
    submit,
  };
};
