/**
 * 账号密码登录。
 *
 * 与验证码登录同属"表单类"，但错误处理路径更杂：
 * 上游把业务错误包在 502 的 body 里抛出，字段名还可能是 `error` / `message` /
 * `msg` / `data`（四种都见过），所以这里统一收敛成一个 `readMessage`。
 *
 * ⚠️ 风控验证是**独立分支**：`loginByPassword` 触发风控时，
 * 内核的 `utils/request.ts` 会挂起直到验证被解决或取消，最终抛出的错误
 * 文案是「已取消安全验证」/「验证未通过」。这两种不该报"登录失败" ——
 * 用户明明是自己取消的，报"失败"会让人以为账号有问题。
 */
import { computed, ref } from 'vue';
import { loginByPassword } from '@/api/user';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';

const readMessage = (source: unknown, fallback: string): string => {
  if (!source || typeof source !== 'object') return fallback;
  const record = source as Record<string, unknown>;
  const raw = record.data ?? record.error ?? record.message ?? record.msg;
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim();
  return text || fallback;
};

const readBody = (error: unknown): unknown => {
  if (!error || typeof error !== 'object') return null;
  return (error as { response?: { body?: unknown } }).response?.body ?? null;
};

export const useAccountLogin = (onLoggedIn: () => void) => {
  const userStore = useUserStore();

  const username = ref('');
  const password = ref('');
  const error = ref('');
  const submitting = ref(false);

  const canSubmit = computed(
    () => !submitting.value && username.value.trim().length > 0 && password.value.length > 0,
  );

  const submit = async () => {
    if (submitting.value) return;
    const account = username.value.trim();
    const secret = password.value;
    if (!account) {
      error.value = '请输入用户名';
      return;
    }
    if (!secret) {
      error.value = '请输入密码';
      return;
    }

    submitting.value = true;
    error.value = '';
    try {
      const response: any = await loginByPassword(account, secret);
      if (Number(response?.status) === 1 && response?.data) {
        userStore.login(response.data as Record<string, unknown>);
        onLoggedIn();
        return;
      }
      error.value = readMessage(response, '登录失败，请稍后重试');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes('已取消安全验证') || message.includes('验证未通过')) {
        // 风控分支：把上游原文透出去，不伪装成"登录失败"
        error.value = message;
      } else {
        logger.warn('AccountLogin', 'loginByPassword failed', caught);
        error.value = readMessage(readBody(caught), '登录失败，请稍后重试');
      }
    } finally {
      submitting.value = false;
    }
  };

  return { username, password, error, submitting, canSubmit, submit };
};
