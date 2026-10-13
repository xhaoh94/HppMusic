<script setup lang="ts">
/**
 * 触屏滑块（进度条 / 任意数值）。
 *
 * 与桌面滑块（reka-ui 那套 hover/键盘优先）的区别都在触屏实践上：
 *
 * 1. **拖动期间不回写外部值**。`v-model` 通常是播放进度（每 250ms 被引擎更新），
 *    如果拖动中跟着外部值走，手指还没松，滑块就会被引擎的旧进度"拽回去"
 *    （表现为抖动、拖不动）。所以拖动中用本地值，松手才上报。
 * 2. **触区比视觉轨道大得多**：轨道 4px，触区 32px。手指按不准 4px。
 * 3. **用 pointer 事件而不是 touch**：统一处理鼠标/触控/触控笔，
 *    并且能拿到 `setPointerCapture` —— 手指滑出元素范围后仍能继续拖。
 * 4. 只有 `pointerdown` 之后的移动才算拖动；单纯滑动页面不应改变进度。
 *
 * 无障碍：作为 slider 角色，支持左右方向键与 Home/End。
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    /** 无障碍标签；进度条必须给，否则读屏用户不知道这是什么 */
    label: string;
    disabled?: boolean;
    /** 拖动结束/键盘调整后触发（进度条用它提交 seek） */
    commitOnInput?: boolean;
  }>(),
  { min: 0, max: 1, disabled: false, commitOnInput: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: number];
  /** 提交（拖动结束或键盘操作） */
  commit: [value: number];
  /** 拖动开始/结束，供 UI 决定是否暂停进度跟随 */
  dragging: [value: boolean];
}>();

const trackRef = ref<HTMLDivElement | null>(null);
const dragging = ref(false);
/** 拖动中的本地值；非拖动时为 null（表示"跟随 modelValue"） */
const localValue = ref<number | null>(null);

const clamp = (value: number) => Math.min(props.max, Math.max(props.min, value));

const value = computed(() => (localValue.value === null ? props.modelValue : localValue.value));

const percent = computed(() => {
  const span = props.max - props.min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return ((value.value - props.min) / span) * 100;
});

const valueFromEvent = (clientX: number): number => {
  const track = trackRef.value;
  if (!track) return props.modelValue;
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return props.modelValue;
  const ratio = (clientX - rect.left) / rect.width;
  return clamp(props.min + ratio * (props.max - props.min));
};

const onPointerDown = (event: PointerEvent) => {
  if (props.disabled) return;
  dragging.value = true;
  localValue.value = valueFromEvent(event.clientX);
  emit('dragging', true);
  // 捕获指针：手指滑出轨道范围后仍继续收到 move 事件
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
};

const onPointerMove = (event: PointerEvent) => {
  if (!dragging.value || props.disabled) return;
  localValue.value = valueFromEvent(event.clientX);
  if (!props.commitOnInput) emit('update:modelValue', localValue.value);
};

const finishDrag = () => {
  if (!dragging.value) return;
  dragging.value = false;
  const finalValue = localValue.value;
  localValue.value = null;
  emit('dragging', false);
  if (finalValue === null) return;
  emit('update:modelValue', finalValue);
  emit('commit', finalValue);
};

const onKeydown = (event: KeyboardEvent) => {
  if (props.disabled) return;
  const span = props.max - props.min;
  const step = span / 20;
  let next: number | null = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = clamp(value.value + step);
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = clamp(value.value - step);
  else if (event.key === 'Home') next = props.min;
  else if (event.key === 'End') next = props.max;
  if (next === null) return;
  event.preventDefault();
  emit('update:modelValue', next);
  emit('commit', next);
};
</script>

<template>
  <div
    ref="trackRef"
    class="slider"
    :class="{ 'is-dragging': dragging, 'is-disabled': disabled }"
    role="slider"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="value"
    :aria-disabled="disabled || undefined"
    :tabindex="disabled ? -1 : 0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
    @keydown="onKeydown"
  >
    <div class="slider-track">
      <div class="slider-fill" :style="{ width: `${percent}%` }" />
    </div>
    <span class="slider-thumb" :style="{ left: `${percent}%` }" aria-hidden="true" />
  </div>
</template>

<style scoped>
.slider {
  position: relative;
  display: flex;
  align-items: center;
  /* 触区 32px（手指按不准 4px 的轨道），视觉轨道只有 4px */
  height: 32px;
  touch-action: none;
  cursor: pointer;
  outline: none;
}

.slider.is-disabled {
  cursor: default;
  opacity: 0.5;
}

/* 键盘聚焦时才显示焦点环：触屏上点一下不该出现一个方块 */
.slider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.slider-track {
  width: 100%;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
  overflow: hidden;
}

.slider-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--accent);
}

.slider-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateY(-50%) scale(0);
  transition: transform var(--duration-fast) var(--ease-standard);
  pointer-events: none;
}

/* 拖动中或设备支持 hover 时显示滑块；纯触屏静止状态不显示，避免遮挡 */
.slider.is-dragging .slider-thumb,
.slider:focus-visible .slider-thumb {
  transform: translateY(-50%) scale(1);
}

@media (hover: hover) {
  .slider:hover .slider-thumb {
    transform: translateY(-50%) scale(1);
  }
}
</style>
