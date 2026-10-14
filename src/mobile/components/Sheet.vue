<script setup lang="ts">
/**
 * 底部抽屉（bottom sheet）—— 移动端最常用的浮层形态。
 *
 * 为什么不用桌面那套 Popover/Tooltip：它们依赖 hover 触发 + 锚点定位，
 * 触屏上没有 hover 事件，锚点在窄屏上又容易飞出屏幕。移动端一律用抽屉：
 * 从底部升起、贴满宽度、可下滑关闭、系统返回键优先关它。
 *
 * 与内核的 toast store 无关，纯 UI 组件。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { pushBackHandler } from '@bridge/backButton';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    /** 点遮罩是否关闭（操作确认类抽屉建议改成 false，避免误触丢失输入） */
    dismissOnMask?: boolean;
    /**
     * 提到 `--z-dialog` 层。
     *
     * 用于「必须先处理完才能继续」的浮层（典型是风控验证）。它们由 App 根挂载，
     * 而页面自己也可能开着 Sheet（如创建众乐房的表单），两者同为 `--z-sheet`，
     * 这时**DOM 靠后的页面层会把全局浮层盖住** —— 实测踩到：选公开房间触发实名验证，
     * 验证弹窗被创建表单压住，看不见也点不到。
     */
    elevated?: boolean;
  }>(),
  { title: '', dismissOnMask: true, elevated: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const closing = ref(false);

const close = () => {
  if (!props.modelValue) return;
  closing.value = true;
  emit('update:modelValue', false);
};

watch(
  () => props.modelValue,
  (open) => {
    // 打开时重置关闭态，否则第二次打开会带着上一次的退场动画
    if (open) closing.value = false;
  },
);

/**
 * 返回键优先关抽屉。
 *
 * pushBackHandler 是倒序询问的：抽屉在组件挂载时注册，比外壳的兜底处理器更晚，
 * 所以会先被问到 —— 这正是「上层浮层优先」的语义，不需要额外的优先级字段。
 */
let offBack: (() => void) | null = null;
onMounted(() => {
  offBack = pushBackHandler(() => {
    if (!props.modelValue) return false;
    close();
    return true;
  });
});
onBeforeUnmount(() => offBack?.());
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div
        v-if="modelValue"
        class="sheet-mask"
        :class="{ 'is-elevated': elevated }"
        @click.self="dismissOnMask && close()"
      >
        <div class="sheet-panel" role="dialog" :aria-label="title || undefined">
          <span class="sheet-handle" aria-hidden="true" />
          <header v-if="title || $slots.header" class="sheet-header">
            <slot name="header">
              <h2 class="sheet-title">{{ title }}</h2>
            </slot>
          </header>
          <div class="sheet-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="sheet-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.5);
}

/* 全局阻断型浮层：必须盖过页面自己开的 Sheet */
.sheet-mask.is-elevated {
  z-index: var(--z-dialog);
}

.sheet-panel {
  width: 100%;
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
  padding-bottom: var(--safe-bottom);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background: var(--bg-sheet);
  box-shadow: var(--shadow-sheet);
}

.sheet-handle {
  display: block;
  flex: 0 0 auto;
  width: 36px;
  height: 4px;
  margin: var(--sp-3) auto var(--sp-2);
  border-radius: var(--radius-pill);
  background: var(--divider-strong);
}

.sheet-header {
  flex: 0 0 auto;
  padding: 0 var(--sp-5) var(--sp-2);
}

.sheet-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--sp-2) var(--sp-5) var(--sp-5);
  scrollbar-width: none;
}

.sheet-body::-webkit-scrollbar {
  display: none;
}

.sheet-footer {
  flex: 0 0 auto;
  padding: var(--sp-3) var(--sp-5) var(--sp-4);
  border-top: 1px solid var(--divider);
}

/* ── 进出场：位移 + 淡入，240ms 内完成 ── */
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--duration-normal) var(--ease-standard);
}

.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform var(--duration-normal) var(--ease-standard);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet-panel,
.sheet-leave-to .sheet-panel {
  transform: translateY(100%);
}
</style>
