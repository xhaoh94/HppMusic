<script setup lang="ts">
/**
 * 开关型设置项。
 *
 * 整行可点（不只是开关本身）—— 触屏上把小开关当唯一热区是常见的可用性错误。
 * 开关本身是自研 div，不用 `<input type=checkbox>`：后者的系统样式在
 * 各家 WebView 上差异很大，而且难以做成 iOS/Android 都认可的那种胶囊开关。
 */
const props = defineProps<{
  label: string;
  description?: string;
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const toggle = () => {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
};
</script>

<template>
  <button
    type="button"
    class="switch-row"
    :class="{ 'is-disabled': disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-disabled="disabled || undefined"
    @click="toggle"
  >
    <span class="row-text">
      <span class="row-label">{{ label }}</span>
      <span v-if="description" class="row-description">{{ description }}</span>
    </span>
    <span class="switch" :class="{ 'is-on': modelValue }" aria-hidden="true">
      <span class="knob" />
    </span>
  </button>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  width: 100%;
  min-height: 56px;
  padding: var(--sp-2) 0;
  text-align: left;
}

.switch-row:active:not(.is-disabled) {
  background: var(--fill-subtle);
}

.switch-row.is-disabled {
  opacity: 0.5;
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

.row-description {
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
}

/* ── 胶囊开关 ── */
.switch {
  flex: 0 0 48px;
  position: relative;
  width: 48px;
  height: 28px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
  transition: background var(--duration-normal) var(--ease-standard);
}

.switch.is-on {
  background: var(--accent);
}

.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform var(--duration-normal) var(--ease-standard);
}

.switch.is-on .knob {
  transform: translateX(20px);
}
</style>
