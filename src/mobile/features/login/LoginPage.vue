<script setup lang="ts">
/**
 * 登录页。
 *
 * ## 五种登录方式（对齐旧项目）
 *
 * | 方式 | 类型 | 上游 | 说明 |
 * |---|---|---|---|
 * | 酷狗 | 扫码 | `/login/qr/*` | 概念版 App 扫码 |
 * | 验证码 | 表单 | `/captcha/sent` + `/login/cellphone` | 单设备时的保底 |
 * | 账号 | 表单 | `/login` | 用户名 + 密码 |
 * | QQ | 扫码 | `/login/qq/qr/*` | 需要登录过 QQ 音乐 |
 * | 微信 | 扫码 | `/login/wx/*` + `/login/openplat` | 需二次换登录态 |
 *
 * 三种扫码共用 `useQrSession`（轮询/超时/防竞态/会话检查只有一份实现），
 * 平台差异全部收在 `qrAdapters.ts`。
 *
 * ## 视觉对齐旧项目
 *
 * 旧项目的登录页是**一张卡片**：上半部分是当前方式的内容（标题 + 副标题 + 控件），
 * 下半部分是「选择登录方式」的 **5 列图标网格**（不是顶部的文字 tab）。
 * 这里照这个结构复刻，配色沿用各自的品牌色（QQ `#12b7f5` / 微信 `#07c160`）。
 *
 * 两处刻意的偏差：
 * · 卡片**不固定高度**（旧项目写死 510px 是为了桌面居中；手机上横屏/小屏会溢出）
 * · 内边距按手机收窄（旧项目的 `px-10` 在 360px 屏上只剩 200px 可用宽度）
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import type { IconifyIcon } from '@iconify/types';
import {
  iconBrandQq,
  iconBrandWechat,
  iconInfo,
  iconLock,
  iconPhone,
  iconQrCode,
  iconRefresh,
  iconSpinner,
  iconUser,
} from '@mobile/icons';
import { useSmsLogin } from './useSmsLogin';
import { useAccountLogin } from './useAccountLogin';
import { useQrSession, type QrSession } from './useQrSession';
import { createKugouQrAdapter, createQqQrAdapter, createWxQrAdapter } from './qrAdapters';

const router = useRouter();

const onLoggedIn = () => {
  void router.replace({ name: 'home' });
};

type LoginMethod = 'kugou' | 'sms' | 'account' | 'qq' | 'wechat';

interface LoginMethodMeta {
  value: LoginMethod;
  label: string;
  icon: IconifyIcon;
  tone: 'primary' | 'qq' | 'wechat';
  title: string;
  subtitle: string;
}

const METHODS: LoginMethodMeta[] = [
  {
    value: 'kugou',
    label: '酷狗',
    icon: iconQrCode,
    tone: 'primary',
    title: '扫码登录',
    subtitle: '使用酷狗概念版扫码',
  },
  {
    value: 'sms',
    label: '验证码',
    icon: iconPhone,
    tone: 'primary',
    title: '验证码登录',
    subtitle: '无需密码，快捷安全',
  },
  {
    value: 'account',
    label: '账号',
    icon: iconUser,
    tone: 'primary',
    title: '账号登录',
    subtitle: '使用酷狗账号密码',
  },
  {
    value: 'qq',
    label: 'QQ',
    icon: iconBrandQq,
    tone: 'qq',
    title: 'QQ 登录',
    subtitle: '使用 QQ 扫码授权',
  },
  {
    value: 'wechat',
    label: '微信',
    icon: iconBrandWechat,
    tone: 'wechat',
    title: '微信登录',
    subtitle: '使用微信扫码授权',
  },
];

const method = ref<LoginMethod>('kugou');
const activeMeta = computed(() => METHODS.find((item) => item.value === method.value) ?? METHODS[0]);

/* ── 三个扫码会话 ── */
const kugouQr = useQrSession(createKugouQrAdapter(), onLoggedIn);
const qqQr = useQrSession(createQqQrAdapter(), onLoggedIn);
const wxQr = useQrSession(createWxQrAdapter(), onLoggedIn);

const qrSessions: Record<'kugou' | 'qq' | 'wechat', QrSession> = {
  kugou: kugouQr,
  qq: qqQr,
  wechat: wxQr,
};

/** 当前方式对应的扫码会话（表单类方式返回 null） */
const activeQr = computed<QrSession | null>(() => {
  if (method.value === 'kugou') return kugouQr;
  if (method.value === 'qq') return qqQr;
  if (method.value === 'wechat') return wxQr;
  return null;
});

/* ── 两个表单 ── */
const sms = useSmsLogin(onLoggedIn);
const account = useAccountLogin(onLoggedIn);

const codeInput = ref<HTMLInputElement | null>(null);

const qrStatusText = computed(() => {
  const session = activeQr.value;
  if (!session) return '';
  if (session.state.value === 'loading') return '正在生成二维码';
  if (session.state.value === 'scanned') return session.message.value || '已扫码，等待确认';
  if (session.state.value === 'expired') return session.message.value || '二维码已过期';
  if (session.state.value === 'error') return session.error.value || '二维码加载失败';
  return '等待扫码';
});

const qrNeedsReload = computed(() => {
  const session = activeQr.value;
  return session?.state.value === 'expired' || session?.state.value === 'error';
});

/** 切换方式：停掉旧的扫码轮询，激活新的（已有有效二维码则只恢复轮询） */
const switchMethod = (next: LoginMethod) => {
  if (method.value === next) return;
  const previous = activeQr.value;
  method.value = next;
  const current = activeQr.value;
  if (previous && previous !== current) previous.stop();
  current?.activate();
};

const onSwitchMethod = (next: LoginMethod) => switchMethod(next);

const onSendCode = async () => {
  await sms.sendCode();
  codeInput.value?.focus();
};

const loadQr = () => activeQr.value?.reload();

// 初始激活扫码（默认方式）
kugouQr.activate();

watch(method, (value) => {
  // 切到某个扫码方式但还没码（例如从表单切回来）时补一次
  if (value === 'kugou' || value === 'qq' || value === 'wechat') {
    const session = qrSessions[value];
    if (!session.imageUrl.value) session.activate();
  }
});

onBeforeUnmount(() => {
  kugouQr.stop();
  qqQr.stop();
  wxQr.stop();
});
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 上半部分：当前方式的内容 -->
      <section class="login-panel">
        <header class="panel-head">
          <h1 class="panel-title">{{ activeMeta.title }}</h1>
          <p class="panel-subtitle">{{ activeMeta.subtitle }}</p>
        </header>

        <!-- ── 扫码类（酷狗 / QQ / 微信）── -->
        <div v-if="activeQr" class="qr-block">
          <div class="qr-surface">
            <img
              v-if="activeQr.imageUrl.value"
              class="qr-image"
              :src="activeQr.imageUrl.value"
              :alt="`${activeMeta.label}登录二维码`"
            />
            <div v-else class="qr-placeholder">
              <Icon :icon="iconSpinner" width="24" height="24" class="spin" />
            </div>

            <!-- 已扫码：压一层明确的反馈，避免用户继续对着码看 -->
            <div v-if="activeQr.state.value === 'scanned'" class="qr-overlay is-scanned">
              <span class="qr-check" aria-hidden="true">
                <Icon :icon="iconUser" width="26" height="26" />
              </span>
              <p class="qr-overlay-title">请在设备上确认</p>
            </div>
            <!-- 失效/出错：给重新获取入口 -->
            <div v-else-if="qrNeedsReload" class="qr-overlay">
              <p class="qr-overlay-title">{{ qrStatusText }}</p>
              <button type="button" class="qr-reload" @click="loadQr">
                <Icon :icon="iconRefresh" width="14" height="14" />
                重新加载
              </button>
            </div>
          </div>

          <div class="qr-status-row">
            <span class="qr-status-text">{{ qrStatusText }}</span>
            <button
              type="button"
              class="qr-refresh-icon"
              aria-label="刷新二维码"
              :disabled="activeQr.state.value === 'loading'"
              @click="loadQr"
            >
              <Icon :icon="iconRefresh" width="14" height="14" />
            </button>
          </div>
        </div>

        <!-- ── 验证码 ── -->
        <form v-else-if="method === 'sms'" class="form" @submit.prevent="sms.submit()">
          <label class="field">
            <Icon :icon="iconPhone" width="17" height="17" class="field-icon" />
            <input
              v-model="sms.mobile.value"
              class="field-input"
              type="tel"
              inputmode="numeric"
              autocomplete="tel"
              maxlength="11"
              placeholder="手机号码"
              :disabled="sms.submitting.value"
            />
          </label>

          <label class="field">
            <input
              ref="codeInput"
              v-model="sms.code.value"
              class="field-input"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="验证码"
              :disabled="sms.submitting.value"
            />
            <button
              type="button"
              class="code-button"
              :disabled="!sms.canSendCode.value"
              @click="onSendCode"
            >
              <Icon v-if="sms.sending.value" :icon="iconSpinner" width="15" height="15" class="spin" />
              <span v-else-if="sms.countdown.value > 0">{{ sms.countdown.value }}s</span>
              <span v-else>获取验证码</span>
            </button>
          </label>

          <p v-if="sms.error.value" class="form-error" role="alert">{{ sms.error.value }}</p>

          <button type="submit" class="submit-button" :disabled="!sms.canSubmit.value">
            <Icon v-if="sms.submitting.value" :icon="iconSpinner" width="17" height="17" class="spin" />
            <span>{{ sms.submitting.value ? '登录中…' : '登录' }}</span>
          </button>
        </form>

        <!-- ── 账号密码 ── -->
        <form v-else class="form" @submit.prevent="account.submit()">
          <label class="field">
            <Icon :icon="iconUser" width="17" height="17" class="field-icon" />
            <input
              v-model="account.username.value"
              class="field-input"
              type="text"
              autocapitalize="off"
              autocomplete="username"
              placeholder="用户名 / 手机号"
              :disabled="account.submitting.value"
            />
          </label>

          <label class="field">
            <Icon :icon="iconLock" width="17" height="17" class="field-icon" />
            <input
              v-model="account.password.value"
              class="field-input"
              type="password"
              autocomplete="current-password"
              placeholder="密码"
              :disabled="account.submitting.value"
            />
          </label>

          <p v-if="account.error.value" class="form-error" role="alert">
            {{ account.error.value }}
          </p>

          <button type="submit" class="submit-button" :disabled="!account.canSubmit.value">
            <Icon
              v-if="account.submitting.value"
              :icon="iconSpinner"
              width="17"
              height="17"
              class="spin"
            />
            <span>{{ account.submitting.value ? '登录中…' : '登录' }}</span>
          </button>
        </form>

        <!-- 一个手机号绑定了多个酷狗账号时，上游会返回候选列表，必须让用户选一个 -->
        <section v-if="method === 'sms' && sms.accountCandidates.value.length" class="accounts">
          <p class="accounts-title">该手机号下有多个账号，请选择</p>
          <button
            v-for="candidate in sms.accountCandidates.value"
            :key="candidate.userid"
            type="button"
            class="account-item"
            :disabled="sms.submitting.value"
            @click="sms.submit(candidate.userid)"
          >
            <img v-if="candidate.pic" class="account-avatar" :src="candidate.pic" alt="" />
            <span v-else class="account-avatar" aria-hidden="true" />
            <span class="account-name ellipsis">{{ candidate.nickname }}</span>
            <Icon
              v-if="sms.pendingUserid.value === candidate.userid"
              :icon="iconSpinner"
              width="15"
              height="15"
              class="spin"
            />
          </button>
        </section>
      </section>

      <!-- 下半部分：选择登录方式（对齐旧项目的 5 列图标网格） -->
      <footer class="login-methods">
        <span class="methods-label">选择登录方式</span>
        <div class="methods-grid">
          <button
            v-for="item in METHODS"
            :key="item.value"
            type="button"
            class="method-trigger"
            :class="{ 'is-active': method === item.value }"
            :data-tone="item.tone"
            :aria-label="`${item.label}登录`"
            :aria-pressed="method === item.value"
            @click="onSwitchMethod(item.value)"
          >
            <Icon :icon="item.icon" width="20" height="20" />
            <span class="method-label">{{ item.label }}</span>
          </button>
        </div>
      </footer>
    </div>

    <!-- 没有酷狗账号的指引：这个应用只能登录已有账号，不能注册 -->
    <div class="tip-banner">
      <span class="tip-icon" aria-hidden="true">
        <Icon :icon="iconInfo" width="12" height="12" />
      </span>
      <p class="tip-text">
        首次使用 HppMusic？请先在手机端下载《酷狗概念版》，完成账号注册并成功登录后，再返回这里登录。
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  height: 100%;
  padding: calc(var(--safe-top) + var(--sp-5)) var(--sp-4) calc(var(--safe-bottom) + var(--sp-5));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.login-page::-webkit-scrollbar {
  display: none;
}

/* ── 卡片 ── */
.login-card {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  /**
   * `margin: auto 0` 而不是父级 `justify-content: center`：
   * 两者都是垂直居中，但内容超出容器时 flex 居中会把**顶部**裁掉
   * （顶部溢出无法滚动到），而 auto margin 会让它自然从顶部开始排。
   * 表单类方式在小屏 + 键盘弹出时很容易超出。
   */
  margin: auto 0;
  /* 旧项目写死 510px 是为了桌面居中；这里让它随内容长，否则横屏/小屏会溢出 */
  min-height: 480px;
  border-radius: var(--radius-xl);
  background: var(--bg-sheet);
  border: 1px solid var(--divider);
  overflow: hidden;
}

.login-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-5) var(--sp-4);
}

.panel-head {
  text-align: center;
}

.panel-title {
  margin: 0 0 var(--sp-1);
  font-size: var(--font-2xl);
  font-weight: var(--weight-bold);
  letter-spacing: -0.01em;
}

.panel-subtitle {
  margin: 0;
  font-size: var(--font-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

/* ── 二维码 ── */
.qr-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
}

.qr-surface {
  position: relative;
  width: 192px;
  height: 192px;
  padding: 14px;
  border-radius: var(--radius-lg);
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
  padding: var(--sp-3);
  border-radius: var(--radius-lg);
  /* 白底黑字：二维码必须保持可读对比度，不能跟随深色主题 */
  background: rgba(255, 255, 255, 0.96);
  color: #17171d;
  text-align: center;
}

.qr-overlay.is-scanned {
  gap: var(--sp-2);
}

.qr-overlay-title {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: var(--weight-bold);
}

.qr-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #22c55e;
  color: #fff;
}

.qr-reload {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: 34px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: var(--weight-bold);
  color: #17171d;
  background: rgba(0, 0, 0, 0.06);
}

/* 状态行：左边一句话，右边刷新按钮（对齐旧项目的布局） */
.qr-status-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.qr-status-text {
  font-size: var(--font-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

.qr-refresh-icon {
  position: absolute;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.qr-refresh-icon:active:not(:disabled) {
  background: var(--fill-muted);
  color: var(--text-primary);
}

/* ── 表单 ── */
.form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: 50px;
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
  font-size: var(--font-md);
}

.code-button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 88px;
  min-height: 34px;
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

.form-error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
  text-align: center;
}

.submit-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 50px;
  margin-top: var(--sp-2);
  border-radius: var(--radius-md);
  font-size: var(--font-lg);
  font-weight: var(--weight-bold);
  color: var(--accent-on);
  background: var(--accent);
}

.submit-button:disabled {
  opacity: 0.45;
}

.submit-button:active:not(:disabled) {
  background: var(--accent-pressed);
}

/* ── 多账号选择 ── */
.accounts {
  width: 100%;
  padding: var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--divider);
}

.accounts-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.account-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.account-item:active {
  background: var(--fill-subtle);
}

.account-avatar {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill-muted);
}

.account-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
}

/* ── 底部方式选择 ── */
.login-methods {
  flex: 0 0 auto;
  padding: var(--sp-4) var(--sp-4) var(--sp-5);
  border-top: 1px solid var(--divider);
}

.methods-label {
  display: block;
  margin-bottom: var(--sp-3);
  text-align: center;
  font-size: var(--font-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

.methods-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-2);
}

.method-trigger {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  min-height: 56px;
  border-radius: var(--radius-lg);
  border: 1px solid transparent;
  color: var(--text-secondary);
  opacity: 0.65;
  transition:
    color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}

.method-label {
  font-size: 10px;
  line-height: 1;
  font-weight: var(--weight-bold);
}

.method-trigger:active {
  transform: scale(0.96);
}

/* 选中态：主色（QQ/微信各自用自己的品牌色，与旧项目一致） */
.method-trigger.is-active {
  opacity: 1;
  color: var(--accent);
  border-color: var(--accent-soft);
  background: var(--accent-soft);
  transform: translateY(-1px);
}

.method-trigger[data-tone='qq'].is-active {
  color: #12b7f5;
  border-color: rgba(18, 183, 245, 0.28);
  background: rgba(18, 183, 245, 0.1);
}

.method-trigger[data-tone='wechat'].is-active {
  color: #07c160;
  border-color: rgba(7, 193, 96, 0.28);
  background: rgba(7, 193, 96, 0.1);
}

/* ── 提示条 ── */
.tip-banner {
  width: 100%;
  max-width: 420px;
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--radius-md);
  background: rgba(245, 165, 36, 0.12);
  border: 1px solid rgba(245, 165, 36, 0.25);
}

.tip-icon {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--warning);
  color: #fff;
}

.tip-text {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  line-height: 1.5;
  color: var(--warning);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
