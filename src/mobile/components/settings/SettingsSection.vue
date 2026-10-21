<script setup lang="ts">
/**
 * 设置分组（可折叠）。
 *
 * 结构 = 小组标签（12px 三级色）+ 圆角卡片（行装在里面）。标签必须看起来像
 * "组名"而不是"又一行设置"：否则折叠时箭头朝右，会和 ActionRow 的跳转行混成
 * 一类，用户分不清哪组能展开（原来就是这样）。
 *
 * 折叠动画用 `grid-template-rows: 1fr ↔ 0fr`（Chrome 107+，本项目基线 110），
 * 不用 JS 量高度。折叠状态只在本进程内记住，杀进程后恢复默认。
 */
import { computed } from 'vue';
import { isSectionCollapsed, setSectionCollapsed } from '@mobile/composables/useSettingsCollapse';

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** 折叠状态的持久化 key；默认用标题（同一页里标题唯一） */
    collapseKey?: string;
    /** 默认是否收起（默认展开） */
    defaultCollapsed?: boolean;
  }>(),
  { description: '', collapseKey: '', defaultCollapsed: false },
);

const STORAGE_KEY_REMOVED = 'hpp.settingsCollapsed';
// 旧版把折叠状态写进了 localStorage（跨重启保留），与现在的约定不符；顺手清掉。
try {
  localStorage.removeItem(STORAGE_KEY_REMOVED);
} catch {
  /* 清不掉不影响功能 */
}

const sectionKey = computed(() => props.collapseKey || props.title);
const collapsed = computed(() => isSectionCollapsed(sectionKey.value, props.defaultCollapsed));

const bodyId = computed(() => `settings-section-${sectionKey.value}`);

const toggle = () => {
  setSectionCollapsed(sectionKey.value, !collapsed.value);
};
</script>

<template>
  <section class="settings-section">
    <h2 class="section-heading">
      <button
        type="button"
        class="section-toggle"
        :aria-expanded="!collapsed"
        :aria-controls="bodyId"
        @click="toggle"
      >
        <span class="section-title">{{ title }}</span>
        <span class="section-chevron" :class="{ 'is-collapsed': collapsed }" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>
    </h2>
    <p v-if="description" class="section-description" :class="{ 'is-hidden': collapsed }">
      {{ description }}
    </p>
    <div :id="bodyId" class="section-body-wrap" :class="{ 'is-collapsed': collapsed }">
      <div class="section-body">
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 组间距只在这里定，避免手写 margin 出现"某一组比别人多 4px" */
.settings-section {
  margin-bottom: var(--sp-5);
}

.section-heading {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
}

/*
 * 分组标题 = 组标签：12px + 三级色 + 字距，和组内行标题（14px + 主色）拉开层级。
 * 原来是同字号加重，结果"外观"和"主题"看起来是一层的东西。
 */
.section-toggle {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
  min-height: 28px;
  padding: 0 var(--sp-1) var(--sp-2);
  text-align: left;
}

.section-toggle:active .section-title {
  color: var(--text-primary);
}

.section-title {
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  letter-spacing: 0.06em;
}

.section-chevron {
  display: inline-flex;
  color: var(--text-tertiary);
  transition: transform var(--duration-normal) var(--ease-standard);
}

.section-chevron.is-collapsed {
  transform: rotate(-90deg);
}

.section-description {
  margin: 0 0 var(--sp-2);
  padding: 0 var(--sp-1);
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

/* 收起时连说明一起隐藏：说明是分组标题的附属，留着会占一整行 */
.section-description.is-hidden {
  display: none;
}

.section-body-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--duration-normal) var(--ease-standard);
}

.section-body-wrap.is-collapsed {
  grid-template-rows: 0fr;
}

/*
 * 卡片：横向 padding 一举两得 —— 行内容相对屏幕内缩，行间分割线也随之变成
 * 内缩线（不然分割线顶到卡片圆角边缘很难看）。垂直方向不设 padding：
 * 折叠时 grid 行高为 0，有垂直 padding 会留下一条卡片底色的残影。
 */
.section-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}

/* 组内相邻项之间的细分割线（最后一项不加） */
.section-body > * + * {
  border-top: 1px solid var(--divider);
}
</style>
