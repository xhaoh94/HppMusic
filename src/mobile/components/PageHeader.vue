<script setup lang="ts">
/**
 * 页面顶部栏。
 *
 * 三种形态合一：
 * · 有大标题（`title`）—— 首页/我的这类一级页面，标题紧跟内容，不做分割线
 * · 有返回箭头（可路由历史 > 1）—— 二级页（歌单详情等）
 * · 右侧动作槽（`actions`）
 *
 * 不做「滚动时标题渐变吸顶」那类动效：它在 WebView 里靠 scroll 事件驱动，
 * 掉帧明显，而收益只是好看。需要吸顶的页面自己用 `sticky` 局部实现。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconBack } from '@mobile/icons';

const props = withDefaults(
  defineProps<{
    title?: string;
    /** 强制显示/隐藏返回箭头；不传时按路由历史自动判断 */
    back?: boolean;
    /** 大标题样式（一级页面） */
    large?: boolean;
  }>(),
  { title: '', back: undefined, large: false },
);

const route = useRoute();
const router = useRouter();

const showBack = computed(() => props.back ?? window.history.length > 1);

const goBack = () => {
  // 无历史时退回主页而不是空白页
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'home' });
};

const containerClass = computed(() => [`is-${route.meta.section ?? 'page'}`]);
</script>

<template>
  <header class="page-header" :class="containerClass">
    <button v-if="showBack" type="button" class="icon-button" aria-label="返回" @click="goBack">
      <Icon :icon="iconBack" width="22" height="22" />
    </button>
    <h1 v-if="title" class="page-title" :class="{ 'is-large': large }">{{ title }}</h1>
    <div class="page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 52px;
  padding: var(--sp-1) var(--sp-4);
}

.page-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
}

.page-title.is-large {
  font-size: var(--font-2xl);
  font-weight: var(--weight-bold);
  padding: var(--sp-3) 0;
}

.page-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.icon-button {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  /* 负外边距让箭头视觉上与页面左内边距对齐，同时保留 40px 的可点区域 */
  margin-left: calc(var(--sp-2) * -1);
  border-radius: 50%;
  color: var(--text-primary);
}

.icon-button:active {
  background: var(--fill-muted);
}
</style>
