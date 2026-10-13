<script setup lang="ts">
/**
 * 单选型设置项（分段控件）。
 *
 * 选项一般 2~4 个。超过 4 个（如音质的 4 档）仍然用它，但会换行 ——
 * 横向挤 4 个中文词在 360px 屏上会把文字压成两行，比换行更难看。
 */
export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

const props = withDefaults(
  defineProps<{
    label: string;
    description?: string;
    options: readonly SegmentedOption<string | number>[];
    modelValue: string | number;
    disabled?: boolean;
    /** 选项多于一屏时是否允许横向滚动（默认换行） */
    scrollable?: boolean;
  }>(),
  { description: '', disabled: false, scrollable: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>();

const select = (value: string | number) => {
  if (props.disabled || value === props.modelValue) return;
  emit('update:modelValue', value);
};
</script>

<template>
  <div class="segmented-row" :class="{ 'is-disabled': disabled }">
    <span class="row-text">
      <span class="row-label">{{ label }}</span>
      <span v-if="description" class="row-description">{{ description }}</span>
    </span>

    <div
      class="segmented"
      :class="{ 'is-scrollable': scrollable }"
      role="radiogroup"
      :aria-label="label"
    >
      <button
        v-for="option in options"
        :key="String(option.value)"
        type="button"
        class="segment"
        :class="{ 'is-active': option.value === modelValue }"
        role="radio"
        :aria-checked="option.value === modelValue"
        :disabled="disabled"
        @click="select(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.segmented-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
}

.segmented-row.is-disabled {
  opacity: 0.5;
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.row-description {
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
}

.segmented {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.segmented.is-scrollable {
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
}

.segmented.is-scrollable::-webkit-scrollbar {
  display: none;
}

.segment {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
  border: 1px solid transparent;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard);
}

.segment.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: var(--weight-semibold);
}
</style>
