<script setup lang="ts">
/**
 * 全局提示宿主。
 *
 * 复用内核的 `useToastStore`（业务侧已经在用它报错/报成功，例如「加载失败」
 * 「登录已过期」），但**渲染完全自研** —— 桌面那套 Toast 组件带 hover 暂停、
 * 复杂堆叠与入场曲线，在触屏上没有意义。
 *
 * 位置：**屏幕中间偏上**（用户明确要求，原来是贴底部栏）。提示出现在视线
 * 自然停留的位置，不必低头找；同时避开底部栏与页面底部的操作区。
 */
import { computed, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import { useToastStore } from '@/stores/toast';
import { iconError, iconInfo, iconSuccess, iconWarning } from '@mobile/icons';

const toast = useToastStore();

/**
 * 提示统一停留 **1 秒**（用户要求）。
 *
 * 内核 store 的默认是 2600ms，部分调用点还显式传了 4s 左右（例如"已加入我喜欢"）。
 * 直接改内核会被 `sync:upstream` 覆盖，所以在移动端宿主这里包一层 show()：
 * 超过 1s 的截到 1s，本来就短的保持不变。
 */
const MAX_TOAST_MS = 1000;
/**
 * 带操作按钮的提示（`showAction`，默认 8 秒）**不能截断** —— 按钮还没看清就消失，
 * 等于功能失效。只压普通提示。
 */
const shouldCap = (action: unknown, presentation?: string) =>
  !action && (presentation === undefined || presentation === 'auto' || presentation === 'standard');

let toastDurationPatched = false;
let unpatchToastDuration: (() => void) | null = null;
const patchToastDuration = () => {
  if (toastDurationPatched) return;
  toastDurationPatched = true;
  const rawShow = toast.show;
  toast.show = ((message, tone = 'info', duration = MAX_TOAST_MS, action, presentation, title) =>
    rawShow.call(
      toast,
      message,
      tone,
      shouldCap(action, presentation) ? Math.min(duration ?? MAX_TOAST_MS, MAX_TOAST_MS) : duration,
      action,
      presentation,
      title,
    )) as typeof toast.show;
  unpatchToastDuration = () => {
    toast.show = rawShow;
    toastDurationPatched = false;
    unpatchToastDuration = null;
  };
};
patchToastDuration();
// 宿主卸载（HMR/结构变化）时还原，避免在已包装的函数外面再包一层
onUnmounted(() => unpatchToastDuration?.());

/**
 * 只渲染**最新一条**：新提示直接顶掉旧的（用户要求，不再堆叠）。
 *
 * store 的 items 是"老的在前、新的在后"（早先按 DOM 顺序验证过），
 * 所以最新一条是数组末尾；直接取下标会比 reverse() 少一次分配。
 */
const items = computed(() => toast.items ?? []);
const current = computed(() => items.value[items.value.length - 1] ?? null);

const iconForTone = (tone: string) => {
  if (tone === 'success') return iconSuccess;
  if (tone === 'warning') return iconWarning;
  if (tone === 'danger') return iconError;
  return iconInfo;
};

const onAction = (id: number, handler: () => void) => {
  handler();
  toast.remove(id);
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite" aria-atomic="false">
      <Transition name="toast" mode="out-in">
        <div
          v-if="current"
          :key="current.id"
          class="toast"
          :class="[`is-${current.tone}`, current.variant === 'mini' ? 'is-mini' : 'is-standard']"
        >
          <Icon
            v-if="current.variant !== 'mini'"
            :icon="iconForTone(current.tone)"
            width="18"
            height="18"
            class="toast-icon"
          />
          <div class="toast-text">
            <p v-if="current.title" class="toast-title">{{ current.title }}</p>
            <p class="toast-message">{{ current.message }}</p>
          </div>
          <span v-if="current.count > 1" class="toast-count">×{{ current.count }}</span>
          <button
            v-if="current.action"
            type="button"
            class="toast-action"
            @click="onAction(current.id, current.action!.handler)"
          >
            {{ current.action.label }}
          </button>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 0;
  right: 0;
  z-index: var(--z-toast);
  /*
   * 位置固定在屏幕**中间偏上**（bottom: 70dvh ≈ 距顶 30%）。
   * 只显示一条提示，所以不再需要堆叠方向的处理。
   */
  top: auto;
  bottom: 70dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  /* 宿主铺满宽度但只有提示本身可点，避免挡住页面的点击 */
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  max-width: 480px;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-md);
  background: var(--bg-overlay);
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-dialog);
}

.toast.is-mini {
  width: auto;
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--radius-pill);
}

.toast-icon {
  flex: 0 0 auto;
}

.toast.is-info .toast-icon {
  color: var(--text-secondary);
}
.toast.is-success .toast-icon {
  color: var(--success);
}
.toast.is-warning .toast-icon {
  color: var(--warning);
}
.toast.is-danger .toast-icon {
  color: var(--danger);
}

.toast-text {
  flex: 1;
  min-width: 0;
}

.toast-title {
  margin: 0 0 2px;
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.toast-message {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-primary);
  word-break: break-word;
}

.toast-count {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.toast-action {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 var(--sp-2);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent);
}

/* ── 进出场：只做淡入淡出（用户要求，不再位移） ── */
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
</style>
