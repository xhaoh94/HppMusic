<script setup lang="ts">
/**
 * 空态 / 错误态的统一呈现。
 *
 * 移动端三类状态必须都画出来（加载 / 空 / 错），否则网络一抖用户看到的是白屏，
 * 会以为应用坏了。这个组件把「空」和「错」收敛成一个：
 * `tone="error"` 时图标与文字用语义色，并多给一个重试按钮。
 */
import { Icon } from '@iconify/vue';
import { iconError, iconInfo, iconSpinner } from '@mobile/icons';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    tone?: 'empty' | 'error' | 'loading';
    actionLabel?: string;
  }>(),
  { description: '', tone: 'empty', actionLabel: '' },
);

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="empty-state">
    <Icon
      :icon="tone === 'error' ? iconError : tone === 'loading' ? iconSpinner : iconInfo"
      width="32"
      height="32"
      class="empty-icon"
      :class="[`is-${tone}`, { spin: tone === 'loading' }]"
    />
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <button v-if="actionLabel" type="button" class="empty-action" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-12) var(--sp-6);
  text-align: center;
}

.empty-icon {
  margin-bottom: var(--sp-2);
  color: var(--text-tertiary);
}

.empty-icon.is-error {
  color: var(--danger);
}

.empty-icon.is-loading {
  color: var(--accent);
}

.empty-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.empty-desc {
  margin: 0;
  max-width: 280px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.empty-action {
  margin-top: var(--sp-3);
  min-height: 40px;
  padding: 0 var(--sp-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
  color: var(--accent);
  background: var(--accent-soft);
}

.empty-action:active {
  opacity: 0.8;
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
