<script setup lang="ts">
/**
 * 设置分组（可折叠）。
 *
 * 两件事：
 * 1. **统一标题与间距** —— 设置页一旦超过 5 个分组，靠手写 margin 必然出现
 *    “某一组比别人多 4px”这种不齐，在深色界面里非常显眼。
 * 2. **可折叠** —— 设置项会越来越多，全展开要翻很久；点击标题栏收起该组。
 *    折叠状态只在本进程内记住（见 `useSettingsCollapse`）：切页签、切走再回来都保持，
 *    但**杀掉 App 后恢复默认**（只展开「外观」那个分组）。
 *
 * 折叠动画用 `grid-template-rows: 1fr ↔ 0fr`：不需要 JS 量高度，也不用给
 * 内容写死 max-height（写死的那种一旦行数变多就会被截断）。Chrome 107+ 支持，
 * 本项目基线是 Chrome 110，安全。
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
// 旧版把折叠状态写进了 localStorage（跨重启保留），与现在的约定不符；
// 顺手清掉，避免留下一条永远没人读的垃圾键。
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
.settings-section {
  padding: var(--sp-4) var(--sp-4) 0;
}

.section-heading {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
}

.section-toggle {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  /* 折叠标题也是可点区域：留足触屏最小尺寸 */
  min-height: 40px;
  margin-left: calc(var(--sp-2) * -1);
  padding: 0 var(--sp-2);
  border-radius: var(--radius-md);
  text-align: left;
}

.section-toggle:active {
  background: var(--fill-subtle);
}

/*
 * 分组标题要比组内的行标题**更有分量**。
 * 原来是 font-sm(12) + tertiary，而组内行标题是 font-md(14) + primary ——
 * 结果是「外观」比「主题」还小，层级看起来是反的（用户反馈“观感差”）。
 * 现在同字号（14）但加重、颜色提一级：靠字重与颜色区分层级，而不是靠缩小。
 */
.section-title {
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  letter-spacing: 0.01em;
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
  margin: var(--sp-1) 0 var(--sp-2);
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

.section-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* 组内相邻项之间加一条细分割线（最后一项不加）。
   子组件根节点会带上本组件的 scoped 属性，所以不需要 :deep() ——
   原来写成 `> :deep(*) + :deep(*)` 是无效语法（lightningcss 会报
   “'deep' is not recognized as a valid pseudo-class”），分割线实际一直没渲染出来。 */
.section-body > * + * {
  border-top: 1px solid var(--divider);
}
</style>
