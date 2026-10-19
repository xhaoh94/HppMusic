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
 *
 * ## 内容区为什么要自己吃一份 --safe-top
 *
 * 上面那条规则只对「自己的顶栏」成立：子页签页由 SubTabBar 吃掉顶部安全区，
 * 但**独立页根本没有顶栏组件**（详情页、设置、搜索、我的…），没人吃这一份，
 * 于是内容直接顶到状态栏/刘海底下。
 *
 * 所以在内容区统一垫一次，带子页签时抵消掉 —— 不能逐个去给 PageHeader 加：
 * 那要改 13 个页面的顶栏，漏一个就静默错位，而这里一处就覆盖全站。
 *
 * 全屏页（`meta.shell === false`：播放/登录/启动/404）除外 —— 它们自己吃
 * 安全区，外壳再垫就是双重留白，播放页顶部还会因此露出一条外壳底色带。
 */
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SubTabBar from './SubTabBar.vue';
import BottomBar from './BottomBar.vue';
import { homeTabs } from './useHomeTabs';
import { pushBackHandler } from '@bridge/backButton';
import { goBackOneLevel } from '@mobile/router';

const route = useRoute();
const router = useRouter();

/** 启动页/登录页/404 等全屏页不带任何导航栏。 */
const shellVisible = computed(() => route.meta.shell !== false);
/** 子页签栏只在「主页」分区出现（对齐参考产品：进搜索/我的时收起）。 */
const subTabVisible = computed(() => shellVisible.value && route.meta.section === 'main');

// ── 主页左右滑切换子页签 ──
//
// 手势判定（按用户要求，横滑列表内容不算）：
// · 起点在横向滚动容器（.scroll-x，轮播图/推荐歌单横列）里 → 是在滚内容，不切；
// · 横向位移 ≥ 56px 且明显大于纵向 → 左滑下一个、右滑上一个。
// 监听放内容区这一层，随便听/发现/推荐歌单……整片都能滑，不用每个页签页各接一遍。
const touchState = { startX: 0, startY: 0, inHorizontalScroller: false, armed: false };

const switchToNeighborTab = (direction: 1 | -1) => {
  const tabs = homeTabs.value;
  const index = tabs.findIndex((tab) => tab.path === route.path);
  if (index < 0) return;
  const next = tabs[index + direction];
  if (!next) return; // 已在边缘：不环绕，避免"滑了没看清滑到哪"的突兀跳变
  void router.push(next.path);
};

const onShellTouchStart = (event: TouchEvent) => {
  touchState.armed = subTabVisible.value;
  if (!touchState.armed) return;
  touchState.startX = event.touches[0].clientX;
  touchState.startY = event.touches[0].clientY;
  const target = event.target;
  touchState.inHorizontalScroller =
    target instanceof Element && !!target.closest('.scroll-x');
};

const onShellTouchEnd = (event: TouchEvent) => {
  const { armed, inHorizontalScroller, startX, startY } = touchState;
  touchState.armed = false;
  if (!armed || inHorizontalScroller) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  // 位移太短、或主要是竖滑（那是在滚页面），都不算切页签
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
  switchToNeighborTab(dx < 0 ? 1 : -1);
};

/**
 * 系统返回键的最后一站：上层浮层都没消费时，按语义退一级。
 *
 * 用 goBackOneLevel 自己决定，而不是把决定权交回原生 —— vue-router 的 pushState
 * 历史在 WebView 的返回栈里不算数，原生 canGoBack() 是 false 就会直接退后台
 * （实测现象："按返回直接回桌面"）。根页面仍返回 false，交给原生退后台（音乐继续播）。
 *
 * 播放页/歌词页/抽屉等更上层的浮层由它们自己注册（后注册的先被问）。
 */
onMounted(() => {
  const off = pushBackHandler(() => goBackOneLevel(router, route.name));
  onUnmounted(off);
});
</script>

<template>
  <div class="shell">
    <SubTabBar v-if="subTabVisible" />

    <main
      class="shell-content"
      :class="{ 'has-sub-tabs': subTabVisible, 'is-fullscreen': !shellVisible }"
      @touchstart="onShellTouchStart"
      @touchend="onShellTouchEnd"
    >
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
  /**
   * 独立页没有顶栏组件去喫顶部安全区，这里统一垫一次。
   * 注意是 padding 而不是给内容加 margin：padding 不计入滚动区，
   * 列表滚到底时不会把这一条一起卷走。
   */
  padding-top: var(--safe-top);
}

/* 子页签栏已经喫过 --safe-top 了，再垫一次就是双倍留白 */
.shell-content.has-sub-tabs {
  padding-top: 0;
}

/* 全屏页（播放/登录/启动/404，meta.shell === false）自己吃安全区。外壳再垫一次
   就是双重留白 —— 播放页顶部还会露出一条外壳底色带：它的背景是自己画的满铺图，
   铺不到 padding 那条 strip 里。 */
.shell-content.is-fullscreen {
  padding-top: 0;
}
</style>
