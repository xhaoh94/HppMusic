<script setup lang="ts">
/**
 * 主页分区的顶部子页签栏：左侧大字页签（可横向滚动）+ 右侧动作区。
 *
 * 交互对齐参考产品：当前页签字号放大 + 下方留一条短下划线；未选中的保持常规字号。
 * 右侧只放「自定义页签」，搜索入口不做成按钮 —— 它已经是主页磁贴里的入口之一，
 * 两处并存容易让人以为是两个不同的搜索。
 */
import { nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import { iconAdd } from '@mobile/icons';
import {
  HOME_TAB_CATALOG,
  homeTabKeys,
  homeTabs,
  resetHomeTabs,
  toggleHomeTab,
  type HomeTab,
} from './useHomeTabs';

const route = useRoute();
const router = useRouter();

const editorOpen = ref(false);
const editorHint = ref('');
const tabList = ref<HTMLElement | null>(null);

// 选中页签自动滚入可见区：页签多了（可自选开关）横向一滚，当前页可能被划出屏幕 ——
// 左右滑切换时尤其明显（高亮变了、页签本身却看不见）。用 inline:center 保证整枚可见。
watch(
  () => route.path,
  () => {
    nextTick(() => {
      tabList.value
        ?.querySelector<HTMLElement>('.tab.is-active')
        ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });
  },
  { immediate: true },
);

const isActive = (tab: HomeTab) =>
  route.path === tab.path || route.path.startsWith(`${tab.path}/`);

const go = (path: string) => {
  if (route.path === path) return;
  void router.push(path);
};

const onToggle = (key: string) => {
  editorHint.value = toggleHomeTab(key);
  // 关掉的正好是当前页签时，路由会被悬空（页签栏无高亮、左右滑也找不到位置）——
  // 这里主动跳到第一个仍启用的页签。
  const stillVisible = homeTabs.value.some(
    (tab) => route.path === tab.path || route.path.startsWith(`${tab.path}/`),
  );
  const fallback = homeTabs.value[0];
  if (!stillVisible && fallback) void router.replace(fallback.path);
};

const onReset = () => {
  resetHomeTabs();
  editorHint.value = '';
};
</script>

<template>
  <header class="sub-tab-bar">
    <nav ref="tabList" class="tab-list scroll-x" aria-label="主页页签">
      <button
        v-for="tab in homeTabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ 'is-active': isActive(tab) }"
        :aria-current="isActive(tab) ? 'page' : undefined"
        @click="go(tab.path)"
      >
        {{ tab.title }}
        <span class="tab-underline" aria-hidden="true" />
      </button>
    </nav>

    <button
      type="button"
      class="action-button"
      aria-label="自定义页签"
      @click="editorOpen = true"
    >
      <Icon :icon="iconAdd" width="19" height="19" />
    </button>
  </header>

  <Sheet v-model="editorOpen" title="主页页签">
    <p v-if="editorHint" class="editor-hint">{{ editorHint }}</p>
    <div class="editor-chips">
      <button
        v-for="tab in HOME_TAB_CATALOG"
        :key="tab.key"
        type="button"
        class="chip"
        :class="{ 'is-on': homeTabKeys.includes(tab.key) }"
        :aria-pressed="homeTabKeys.includes(tab.key)"
        @click="onToggle(tab.key)"
      >
        {{ tab.title }}
      </button>
    </div>
    <button type="button" class="editor-reset" @click="onReset">恢复默认</button>
  </Sheet>
</template>

<style scoped>
.sub-tab-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: calc(var(--sub-tab-bar-height) + var(--safe-top));
  padding: var(--safe-top) var(--sp-2) 0 var(--sp-3);
  background: var(--bg-base);
}

.tab-list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 100%;
}

.tab {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--sp-3);
  font-size: var(--font-lg);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  transition: color var(--duration-normal) var(--ease-standard);
}

.tab.is-active {
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.tab-underline {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 0;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  transform: translateX(-50%);
  transition: width var(--duration-normal) var(--ease-decelerate);
}

.tab.is-active .tab-underline {
  width: 18px;
}

.action-button {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.action-button:active {
  background: var(--fill-muted);
  color: var(--text-primary);
}

/* ── 页签编辑抽屉 ── */
.editor-hint {
  margin: 0 0 var(--sp-4);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.editor-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}

.chip {
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  color: var(--text-primary);
  background: var(--fill-muted);
  border: 1px solid transparent;
  transition:
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.chip.is-on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: var(--weight-semibold);
}

.editor-reset {
  width: 100%;
  min-height: 48px;
  margin-top: var(--sp-5);
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}
</style>
