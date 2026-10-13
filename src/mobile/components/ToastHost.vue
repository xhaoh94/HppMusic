<script setup lang="ts">
/**
 * 全局提示宿主。
 *
 * 复用内核的 `useToastStore`（业务侧已经在用它报错/报成功，例如「加载失败」
 * 「登录已过期」），但**渲染完全自研** —— 桌面那套 Toast 组件带 hover 暂停、
 * 复杂堆叠与入场曲线，在触屏上没有意义。
 *
 * 位置固定在底部栏之上：那条区域在小屏上是最不遮挡内容的（顶部有状态栏，
 * 中间是用户正在看的列表）。
 */
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { useToastStore } from '@/stores/toast';
import { iconError, iconInfo, iconSuccess, iconWarning } from '@mobile/icons';

const toast = useToastStore();

/** mini 变体只在极短消息时用，视觉上是一颗胶囊；standard 是带标题/动作的卡片。 */
const items = computed(() => toast.items ?? []);

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
      <TransitionGroup name="toast">
        <div
          v-for="item in items"
          :key="item.id"
          class="toast"
          :class="[`is-${item.tone}`, item.variant === 'mini' ? 'is-mini' : 'is-standard']"
        >
          <Icon
            v-if="item.variant !== 'mini'"
            :icon="iconForTone(item.tone)"
            width="18"
            height="18"
            class="toast-icon"
          />
          <div class="toast-text">
            <p v-if="item.title" class="toast-title">{{ item.title }}</p>
            <p class="toast-message">{{ item.message }}</p>
          </div>
          <span v-if="item.count > 1" class="toast-count">×{{ item.count }}</span>
          <button
            v-if="item.action"
            type="button"
            class="toast-action"
            @click="onAction(item.id, item.action!.handler)"
          >
            {{ item.action.label }}
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 0;
  right: 0;
  z-index: var(--z-toast);
  /* 抬到底部栏之上；不随页面滚动 */
  bottom: calc(var(--safe-bottom) + var(--bottom-bar-height) + var(--sp-3));
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

/* ── 进出场 ── */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--duration-normal) var(--ease-standard),
    transform var(--duration-normal) var(--ease-standard);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
