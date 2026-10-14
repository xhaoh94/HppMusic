<script setup lang="ts">
/**
 * 登录页。
 *
 * 两种方式并存，**默认扫码**：
 * · 扫码：有两台设备时最省事（不用等短信），也是桌面端的主路径
 * · 验证码：只有一台设备时的保底（手机扫不了自己屏幕上的二维码）
 *
 * 两者共用同一个"登录成功"出口（`userStore.login(data)` + 跳主页），
 * 所以切换方式只是在换输入控件，不涉及登录态处理的重复。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconPhone, iconRefresh, iconSpinner } from '@mobile/icons';
import { useSmsLogin } from './useSmsLogin';
import { useQrLogin } from './useQrLogin';

const router = useRouter();

const onLoggedIn = () => {
  void router.replace({ name: 'home' });
};

type LoginMethod = 'qr' | 'sms';
const method = ref<LoginMethod>('qr');

const {
  mobile,
  code,
  error: smsError,
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

const qr = useQrLogin(onLoggedIn);

const codeInput = ref<HTMLInputElement | null>(null);

const qrHint = computed(() => {
  if (qr.state.value === 'scanned') return '已扫码，请在扫码的设备上确认登录';
  if (qr.state.value === 'expired') return '二维码已失效';
  if (qr.state.value === 'error') return qr.error.value || '二维码加载失败';
  if (qr.state.value === 'loading') return '正在获取二维码…';
  return '用另一台已登录酷狗的设备扫码';
});

const canRefreshQr = computed(
  () => qr.state.value === 'expired' || qr.state.value === 'error',
);

const switchMethod = (next: LoginMethod) => {
  if (method.value === next) return;
  method.value = next;
  if (next === 'qr') void qr.load();
  else qr.stop();
};

const onSendCode = async () => {
  await sendCode();
  codeInput.value?.focus();
};

const pickAccount = (userid: number) => {
  void submit(userid);
};

onMounted(() => {
  // 扫码是默认方式，进页面就开始拉二维码
  void qr.load();
});

// 切回扫码时（例如从验证码返回）自动重新获取，避免展示已失效的旧码
watch(method, (value) => {
  if (value === 'qr' && !qr.imageUrl.value) void qr.load();
});
</script>

<template>
  <div class="login-page">
    <header class="brand">
      <span class="brand-dot" aria-hidden="true" />
      <h1 class="brand-name">HppMusic</h1>
      <p class="brand-sub">登录后即可同步你的歌单与听歌记录</p>
    </header>

    <nav class="method-tabs" role="tablist" aria-label="登录方式">
      <button
        type="button"
        class="method-tab"
        :class="{ 'is-active': method === 'qr' }"
        role="tab"
        :aria-selected="method === 'qr'"
        @click="switchMethod('qr')"
      >
        扫码登录
      </button>
      <button
        type="button"
        class="method-tab"
        :class="{ 'is-active': method === 'sms' }"
        role="tab"
        :aria-selected="method === 'sms'"
        @click="switchMethod('sms')"
      >
        验证码登录
      </button>
    </nav>

    <!-- ── 扫码 ── -->
    <section v-if="method === 'qr'" class="qr-panel">
      <div class="qr-frame">
        <img v-if="qr.imageUrl.value" class="qr-image" :src="qr.imageUrl.value" alt="登录二维码" />
        <div v-else class="qr-placeholder">
          <Icon :icon="iconSpinner" width="24" height="24" class="spin" />
        </div>

        <!-- 已扫码/失效/出错时压一层提示，避免用户对着失效的码反复扫 -->
        <div v-if="qr.state.value === 'scanned'" class="qr-overlay is-scanned">
          <Icon :icon="iconSpinner" width="22" height="22" class="spin" />
          <p>已扫码</p>
          <p class="qr-overlay-sub">请在设备上确认</p>
        </div>
        <div v-else-if="canRefreshQr" class="qr-overlay">
          <p>{{ qrHint }}</p>
          <button type="button" class="qr-refresh" @click="qr.load()">
            <Icon :icon="iconRefresh" width="16" height="16" />
            重新获取
          </button>
        </div>
      </div>

      <p class="qr-hint">{{ qrHint }}</p>
      <p class="qr-tip">只有一台设备？切到「验证码登录」用手机号登录。</p>
    </section>

    <!-- ── 验证码 ── -->
    <form v-else class="form" @submit.prevent="submit()">
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
        <button type="button" class="code-button" :disabled="!canSendCode" @click="onSendCode">
          <Icon v-if="sending" :icon="iconSpinner" width="16" height="16" class="spin" />
          <span v-else-if="countdown > 0">{{ countdown }}s</span>
          <span v-else>获取验证码</span>
        </button>
      </label>

      <p v-if="smsError" class="error" role="alert">{{ smsError }}</p>

      <button type="submit" class="submit-button" :disabled="!canSubmit">
        <Icon v-if="submitting" :icon="iconSpinner" width="18" height="18" class="spin" />
        <span>{{ submitting ? '登录中…' : '登录' }}</span>
      </button>
    </form>

    <!-- 一个手机号绑定了多个酷狗账号时，上游会返回候选列表，必须让用户选一个 -->
    <section v-if="method === 'sms' && accountCandidates.length" class="accounts">
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
  padding: calc(var(--safe-top) + var(--sp-8)) var(--sp-6) calc(var(--safe-bottom) + var(--sp-6));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.login-page::-webkit-scrollbar {
  display: none;
}

.brand {
  flex: 0 0 auto;
  margin-bottom: var(--sp-6);
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

/* ── 方式切换 ── */
.method-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-5);
}

.method-tab {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  color: var(--text-secondary);
  background: var(--fill-subtle);
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.method-tab.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: var(--weight-semibold);
}

/* ── 扫码 ── */
.qr-panel {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.qr-frame {
  position: relative;
  width: 220px;
  height: 220px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: #fff;
}

.qr-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qr-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-tertiary);
}

.qr-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  text-align: center;
  background: rgba(255, 255, 255, 0.94);
  color: #17171d;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
}

.qr-overlay.is-scanned {
  background: rgba(255, 255, 255, 0.9);
  color: #17171d;
}

.qr-overlay p {
  margin: 0;
}

.qr-overlay-sub {
  font-size: var(--font-sm);
  font-weight: var(--weight-regular);
  color: #5f5f6b;
}

.qr-refresh {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 40px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: #fff;
  background: var(--accent);
}

.qr-hint {
  margin: var(--sp-4) 0 0;
  font-size: var(--font-md);
  color: var(--text-secondary);
  text-align: center;
}

.qr-tip {
  margin: var(--sp-2) 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  text-align: center;
}

/* ── 验证码 ── */
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
