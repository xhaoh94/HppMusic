<script setup lang="ts">
/**
 * 移动端外壳：顶部子页签栏（仅主页分区）+ 内容区 + 底部三栏。
 *
 * ## 布局模型：三段 flex 纵向，页面各自内部滚动
 *
 * 两条是刻意选的，不是顺手写的：
 *
 * 1. **两条栏都是 in-flow 的 flex 子项**，不是 fixed 定位。
 *    fixed 方案（旧方案就是）需要在内容区手动补 padding 去躲它，
 *    补多少要跟栏的实际高度严格对齐，改一处高度就得同步改所有页面的 padding；
 *    而且 WebView 里 fixed 元素在滚动/键盘弹出时会出现抖动与错位。
 *    in-flow 之后，「内容区 = 剩下的高度」由 flex 保证，永远不会对不上。
 *
 * 2. **滚动交给页面自己**（内容区 overflow: hidden，页面里放 .scroll-y）。
 *    相比整页 body 滚动：底部栏不会在橡皮筋滚动时跳动；下拉刷新、
 *    上滑收起底栏这类手势将来只需在单页内实现，不用动外壳。
 *
 * 安全区不在这里算 —— 统一桥接成 --safe-*（见 tokens.css 的说明），
 * 由两条栏自己吃自己的那部分（顶部栏吃 --safe-top，底部栏吃 --safe-bottom）。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import SubTabBar from './SubTabBar.vue';
import BottomBar from './BottomBar.vue';
import { pushBackHandler } from '@bridge/backButton';

const route = useRoute();

/** 启动页/登录页/404 等全屏页不带任何导航栏。 */
const shellVisible = computed(() => route.meta.shell !== false);
/** 子页签栏只在「主页」分区出现（对齐参考产品：进搜索/我的时收起）。 */
const subTabVisible = computed(() => shellVisible.value && route.meta.section === 'main');

/**
 * 系统返回键：先问上层浮层，没被消费就交给原生走 WebView 历史后退，
 * 没有历史时原生会退到后台（音乐继续播，这才是音乐应用该有的行为）。
 *
 * 这里注册的是一个"永不消费"的兜底处理器，存在的意义是让询问链有个终点；
 * 播放页/歌词页/抽屉等更上层的浮层由它们自己注册（后注册的先被问）。
 */
onMounted(() => {
  const off = pushBackHandler(() => false);
  onUnmounted(off);
});
</script>

<template>
  <div class="shell">
    <SubTabBar v-if="subTabVisible" />

    <main class="shell-content">
      <slot />
    </main>

    <BottomBar v-if="shellVisible" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  /**
   * 100dvh 而不是 100vh：Android WebView 在键盘弹出、系统栏显隐时可视高度会变，
   * dvh 跟着变，vh 不变 —— 用 vh 会让底部栏被键盘顶出屏幕。
   */
  height: 100dvh;
  background: var(--bg-base);
}

.shell-content {
  flex: 1;
  /* min-height: 0 不能省：flex 子项默认 min-height:auto，内容超出时会把外壳撑破 */
  min-height: 0;
  position: relative;
  overflow: hidden;
}
</style>
