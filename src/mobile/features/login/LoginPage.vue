<script setup lang="ts">
/**
 * 登录页（短信验证码）。
 *
 * 为什么默认是短信而不是扫码：手机上没有第二台设备能扫自己屏幕上的二维码。
 * 桌面端默认停在「酷狗」(扫码) —— 那个默认值在移动端等于「没有可用的登录方式」。
 *
 * 页面本身刻意保持「一张表单」：账号密码 / QQ / 微信等作为 P1 的补充方式加进来，
 * 但首屏不做入口罗列 —— 一个入口都没有的 tab 栏比只有一个可选方式更让人困惑。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconPhone, iconSpinner } from '@mobile/icons';
import { useSmsLogin } from './useSmsLogin';

const router = useRouter();

const onLoggedIn = () => {
  void router.replace({ name: 'home' });
};

const {
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
} = useSmsLogin(onLoggedIn);

const codeInput = ref<HTMLInputElement | null>(null);

const onSendCode = async () => {
  await sendCode();
  codeInput.value?.focus();
};

const pickAccount = (userid: number) => {
  void submit(userid);
};
</script>

<template>
  <div class="login-page">
    <header class="brand">
      <span class="brand-dot" aria-hidden="true" />
      <h1 class="brand-name">HppMusic</h1>
      <p class="brand-sub">登录后即可同步你的歌单与听歌记录</p>
    </header>

    <form class="form" @submit.prevent="submit()">
      <label class="field">
        <Icon :icon="iconPhone" width="18" height="18" class="field-icon" />
        <input
          v-model="mobile"
          class="field-input"
          type="tel"
          inputmode="numeric"
          autocomplete="tel"
          maxlength="11"
          placeholder="手机号"
          :disabled="submitting"
        />
      </label>

      <label class="field">
        <input
          ref="codeInput"
          v-model="code"
          class="field-input"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="验证码"
          :disabled="submitting"
        />
        <button
          type="button"
          class="code-button"
          :disabled="!canSendCode"
          @click="onSendCode"
        >
          <Icon v-if="sending" :icon="iconSpinner" width="16" height="16" class="spin" />
          <span v-else-if="countdown > 0">{{ countdown }}s</span>
          <span v-else>获取验证码</span>
        </button>
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button type="submit" class="submit-button" :disabled="!canSubmit">
        <Icon v-if="submitting" :icon="iconSpinner" width="18" height="18" class="spin" />
        <span>{{ submitting ? '登录中…' : '登录' }}</span>
      </button>
    </form>

    <!-- 一个手机号绑定了多个酷狗账号时，上游会返回候选列表，必须让用户选一个 -->
    <section v-if="accountCandidates.length" class="accounts">
      <p class="accounts-title">该手机号下有多个账号，请选择要登录的账号</p>
      <button
        v-for="account in accountCandidates"
        :key="account.userid"
        type="button"
        class="account-item"
        :disabled="submitting"
        @click="pickAccount(account.userid)"
      >
        <img v-if="account.pic" class="account-avatar" :src="account.pic" alt="" />
        <span v-else class="account-avatar account-avatar-placeholder" aria-hidden="true" />
        <span class="account-name">{{ account.nickname }}</span>
        <Icon
          v-if="pendingUserid === account.userid"
          :icon="iconSpinner"
          width="16"
          height="16"
          class="spin"
        />
      </button>
    </section>

    <footer class="legal">
      <p>登录即表示同意本应用仅用于个人学习与研究，音乐版权归原作者及平台所有。</p>
    </footer>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: calc(var(--safe-top) + var(--sp-10)) var(--sp-6) calc(var(--safe-bottom) + var(--sp-6));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.login-page::-webkit-scrollbar {
  display: none;
}

.brand {
  flex: 0 0 auto;
  margin-bottom: var(--sp-10);
}

.brand-dot {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
}

.brand-name {
  margin: var(--sp-3) 0 var(--sp-2);
  font-size: var(--font-3xl);
  font-weight: var(--weight-bold);
}

.brand-sub {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.form {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: 52px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  border: 1px solid transparent;
  transition: border-color var(--duration-fast) var(--ease-standard);
}

.field:focus-within {
  border-color: var(--accent);
}

.field-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.field-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  outline: none;
  font-size: var(--font-lg);
  color: var(--text-primary);
}

.field-input::placeholder {
  color: var(--text-tertiary);
}

.code-button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 92px;
  min-height: 36px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-medium);
  color: var(--accent);
  background: var(--accent-soft);
}

.code-button:disabled {
  color: var(--text-tertiary);
  background: var(--fill-subtle);
}

.error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
}

.submit-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 52px;
  margin-top: var(--sp-3);
  border-radius: var(--radius-md);
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
  transition: background var(--duration-fast) var(--ease-standard);
}

.submit-button:disabled {
  opacity: 0.45;
}

.submit-button:active:not(:disabled) {
  background: var(--accent-pressed);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 多账号选择 ── */
.accounts {
  flex: 0 0 auto;
  margin-top: var(--sp-6);
  padding: var(--sp-4);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--divider);
}

.accounts-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.account-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 56px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.account-item:active {
  background: var(--fill-subtle);
}

.account-avatar {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill-muted);
}

.account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-md);
}

.legal {
  flex: 1;
  display: flex;
  align-items: flex-end;
  padding-top: var(--sp-8);
}

.legal p {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}
</style>
