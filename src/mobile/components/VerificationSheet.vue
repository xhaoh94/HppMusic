<script setup lang="ts">
/**
 * 安全验证浮层（酷狗风控）。
 *
 * ## 为什么必须有
 *
 * 内核的 `utils/request.ts` 在收到风控挑战时会 `await requestKugouVerification(...)` ——
 * **整个请求会挂在那里直到挑战被解决或取消**。所以界面上如果没有这个浮层，
 * 用户看到的现象是「点了登录，按钮一直转，永远不返回」，连错误都不报。
 *
 * ## 覆盖范围（P0）
 *
 * 已实现：
 * · SMS（v_type 32）—— 输入酷狗下发的短信验证码，提交
 * · LOGIN（v_type 38）—— 提示「去登录确认」
 * · BIND_PHONE / REAL_NAME / ACCOUNT_RISK —— 明确告知要去酷狗客户端处理
 * · 任何类型的「取消」—— 释放挂起的请求，让调用方拿到可读错误
 *
 * **未实现（P1 补）**：腾讯验证码（TX）/ 极验（GT）/ 滑块（KG）等需要
 * 加载第三方验证 SDK 的交互式验证。桌面实现有 700 多行（脚本加载 + iframe 定位 +
 * 清理），且严重依赖桌面窗口布局，不适合直接搬。
 * 在移动端这里给出明确提示并允许取消 —— 宁可让用户知道「需要完成腾讯验证码」，
 * 也不要让请求静默挂死。
 */
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import { iconPhone, iconShield, iconUser } from '@mobile/icons';
import {
  KUGOU_ACCOUNT_RISK_MESSAGE,
  KUGOU_CAPTCHA_PROVIDER_NAMES,
  awaitKugouLoginVerification,
  cancelKugouVerification,
  getKugouCaptchaProvider,
  kugouVerificationState,
  refreshKugouVerificationInfo,
  submitKugouVerification,
} from '@/utils/kugouVerification';

const smsCode = ref('');
const busy = ref(false);

const open = computed({
  get: () => kugouVerificationState.open,
  set: (value: boolean) => {
    if (!value) cancel();
  },
});

const provider = computed(() => getKugouCaptchaProvider(kugouVerificationState.verifyInfo));
const providerName = computed(() => KUGOU_CAPTCHA_PROVIDER_NAMES[provider.value]);
const verifyType = computed(() => Number(kugouVerificationState.verifyInfo?.v_type || 23));
const hasInfo = computed(() => Boolean(kugouVerificationState.verifyInfo));

const isSms = computed(() => provider.value === 'SMS');
const isLogin = computed(() => provider.value === 'LOGIN');
const isBindPhone = computed(() => provider.value === 'BIND_PHONE');
const isRealName = computed(() => provider.value === 'REAL_NAME');
const isAccountRisk = computed(() => provider.value === 'ACCOUNT_RISK');
/** 需要第三方验证 SDK 的类型（P1 前不支持） */
const isInteractiveCaptcha = computed(() =>
  ['TX', 'GT', 'KG', 'KG2', 'SM', 'YD', 'UNKNOWN'].includes(provider.value),
);

const title = computed(() => {
  if (isSms.value) return '短信安全验证';
  if (isLogin.value) return '登录确认';
  if (isBindPhone.value) return '需要绑定手机号';
  if (isRealName.value) return '需要实名认证';
  if (isAccountRisk.value) return '账号被风控';
  return '安全验证';
});

const icon = computed(() => {
  if (isLogin.value || isRealName.value) return iconUser;
  if (isSms.value || isBindPhone.value) return iconPhone;
  return iconShield;
});

const description = computed(() => {
  if (!hasInfo.value) return '尚未取得验证信息，请重新获取';
  if (isSms.value) return '请输入酷狗下发的短信验证码';
  if (isLogin.value) {
    return String(kugouVerificationState.verifyInfo?.show?.msg || '').trim() || '请先完成登录确认';
  }
  if (isBindPhone.value) {
    return (
      String(kugouVerificationState.verifyInfo?.show?.msg || '').trim() ||
      '当前账号需绑定手机号后才能继续，请前往酷狗客户端完成绑定后重试'
    );
  }
  if (isRealName.value) return '请前往酷狗客户端完成实名认证后重试';
  if (isAccountRisk.value) return KUGOU_ACCOUNT_RISK_MESSAGE;
  return `本次操作需要「${providerName.value}」，当前版本尚未支持该验证方式，可取消后稍后重试`;
});

const submitSms = async () => {
  if (busy.value || !smsCode.value.trim()) return;
  busy.value = true;
  try {
    const passed = await submitKugouVerification(smsCode.value);
    if (passed) {
      smsCode.value = '';
      kugouVerificationState.open = false;
    }
  } finally {
    busy.value = false;
  }
};

const startLoginConfirm = async () => {
  if (!hasInfo.value) return;
  busy.value = true;
  try {
    // 释放挂起的挑战：内核据此把状态推进到 'awaiting-login'，调用方随后重新发起登录
    awaitKugouLoginVerification();
  } finally {
    busy.value = false;
  }
};

const retryInfo = async () => {
  busy.value = true;
  try {
    await refreshKugouVerificationInfo();
  } catch {
    /* 失败原因由 kugouVerificationState.error 呈现 */
  } finally {
    busy.value = false;
  }
};

const cancel = () => {
  if (!kugouVerificationState.open) return;
  // 必须调：否则 `utils/request.ts` 里那个 await 永远不返回
  cancelKugouVerification();
  smsCode.value = '';
};
</script>

<template>
  <Sheet v-model="open" :title="title" :dismiss-on-mask="false">
    <div class="verification">
      <div class="verification-icon">
        <Icon :icon="icon" width="26" height="26" />
      </div>

      <p class="verification-desc">{{ description }}</p>

      <template v-if="isSms">
        <input
          v-model="smsCode"
          class="verification-input"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="短信验证码"
          :disabled="busy"
          @keyup.enter="submitSms"
        />
        <button
          type="button"
          class="primary-button"
          :disabled="busy || !smsCode.trim()"
          @click="submitSms"
        >
          提交验证
        </button>
      </template>

      <template v-else-if="isLogin">
        <button type="button" class="primary-button" :disabled="busy" @click="startLoginConfirm">
          去登录确认
        </button>
      </template>

      <template v-else-if="!hasInfo">
        <button type="button" class="primary-button" :disabled="busy" @click="retryInfo">
          重新获取验证信息
        </button>
      </template>

      <template v-else-if="isInteractiveCaptcha">
        <p class="verification-note">验证类型：{{ providerName }} / v_type={{ verifyType }}</p>
      </template>

      <p v-if="kugouVerificationState.error" class="verification-error">
        {{ kugouVerificationState.error }}
      </p>
    </div>

    <template #footer>
      <button type="button" class="ghost-button" :disabled="busy" @click="cancel">取消</button>
    </template>
  </Sheet>
</template>

<style scoped>
.verification {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  align-items: stretch;
}

.verification-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin: 0 auto;
  border-radius: 50%;
  color: var(--accent);
  background: var(--accent-soft);
}

.verification-desc {
  margin: 0;
  text-align: center;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.verification-input {
  height: 48px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--divider);
  background: var(--bg-input);
  font-size: var(--font-lg);
  /* 验证码逐位输入，字距拉开更好读；满宽居中避免视觉偏左 */
  text-align: center;
  letter-spacing: 0.3em;
  outline: none;
}

.verification-input:focus {
  border-color: var(--accent);
}

.verification-note {
  margin: 0;
  padding: var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--fill-subtle);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  text-align: center;
}

.verification-error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
  text-align: center;
}

.primary-button {
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.primary-button:disabled {
  opacity: 0.5;
}

.primary-button:active:not(:disabled) {
  background: var(--accent-pressed);
}

.ghost-button {
  width: 100%;
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.ghost-button:active:not(:disabled) {
  background: var(--fill-muted);
}
</style>
