<script setup lang="ts">
/**
 * 通用操作菜单（从底部升起）。
 *
 * 触屏上没有右键，次级操作的标准入口是**长按**。前身项目把歌曲行的右键菜单
 * 直接搬到移动端（结果在手机上根本点不出来），所以这里统一成 ActionSheet。
 *
 * 与 `Sheet.vue` 的分工：Sheet 是「内容容器」（带标题、可滚动的面板），
 * 这个是「一组动作」—— 每项一行、点击即关闭、危险项用警示色。
 * 动作项由调用方给，组件不猜业务含义。
 */
import Sheet from '@mobile/components/Sheet.vue';

export interface ActionSheetItem {
  key: string;
  label: string;
  /** 副标题（如当前状态说明） */
  description?: string;
  /** 危险动作（删除/移除） */
  danger?: boolean;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  title?: string;
  /** 描述当前操作对象，让用户确认点的是哪一首/哪一项 */
  subject?: string;
  items: readonly ActionSheetItem[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  select: [key: string];
}>();

const close = () => emit('update:modelValue', false);

const onSelect = (item: ActionSheetItem) => {
  if (item.disabled) return;
  close();
  emit('select', item.key);
};
</script>

<template>
  <Sheet :model-value="props.modelValue" @update:model-value="emit('update:modelValue', $event)">
    <div class="action-sheet">
      <p v-if="subject" class="sheet-subject ellipsis">{{ subject }}</p>
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="action-item"
        :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled }"
        :disabled="item.disabled"
        @click="onSelect(item)"
      >
        <span class="action-text">
          <span class="action-label">{{ item.label }}</span>
          <span v-if="item.description" class="action-description">{{ item.description }}</span>
        </span>
      </button>
    </div>
  </Sheet>
</template>

<style scoped>
.action-sheet {
  display: flex;
  flex-direction: column;
}

.sheet-subject {
  margin: 0 0 var(--sp-2);
  padding: 0 var(--sp-1);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.action-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: var(--sp-2) var(--sp-1);
  text-align: left;
  border-radius: var(--radius-sm);
}

.action-item + .action-item {
  border-top: 1px solid var(--divider);
}

.action-item:active:not(.is-disabled) {
  background: var(--fill-subtle);
}

.action-item.is-disabled {
  opacity: 0.45;
}

.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.action-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.action-item.is-danger .action-label {
  color: var(--danger);
}

.action-description {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}
</style>
