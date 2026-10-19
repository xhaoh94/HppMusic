<script setup lang="ts">
/**
 * 动作型设置行（点击执行 / 跳转）。
 *
 * 与 SwitchRow 的区别：它没有开关状态，只有"点一下会发生什么"。
 * 危险动作（清除数据）用 `tone="danger"` 把文字染成警示色。
 */
withDefaults(
  defineProps<{
    label: string;
    description?: string;
    /** 右侧的值文字（如版本号、容量） */
    value?: string;
    tone?: 'default' | 'danger';
    disabled?: boolean;
  }>(),
  { description: '', value: '', tone: 'default', disabled: false },
);

const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="action-row"
    :class="[`tone-${tone}`, { 'is-disabled': disabled }]"
    :disabled="disabled"
    @click="emit('click')"
  >
    <span class="row-text">
      <span class="row-label">{{ label }}</span>
      <span v-if="description" class="row-description">{{ description }}</span>
    </span>
    <span v-if="value" class="row-value">{{ value }}</span>
    <span class="chevron" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
  </button>
</template>

<style scoped>
.action-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  /* 48dp 是安卓触屏最小点击尺寸；原来 56 再加 8px 上下 padding，行间空白明显偏大 */
  min-height: 48px;
  padding: 0;
  text-align: left;
}

.action-row:active:not(.is-disabled) {
  background: var(--fill-subtle);
}

.action-row.is-disabled {
  opacity: 0.45;
}

.row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.tone-danger .row-label {
  color: var(--danger);
}

.row-description {
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
}

.row-value {
  flex: 0 0 auto;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.chevron {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
}
</style>
