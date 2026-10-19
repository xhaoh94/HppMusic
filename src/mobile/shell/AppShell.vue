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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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
  // 多指（双指缩放等）不参与切页签：否则第二根手指会覆盖起点，抬手时误判成横滑。
  touchState.armed = subTabVisible.value && event.touches.length === 1;
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

/** 系统手势接管（touchcancel）时复位，避免 armed 残留到下一次手势。 */
const onShellTouchCancel = () => {
  touchState.armed = false;
};

/** 页面内容区：切页时在它身上播一次入场动画。 */
const contentRef = ref<HTMLElement | null>(null);
/**
 * 当前正在播的入场动画（必须走响应式绑定）。
 * '' = 不动画；'tab-next' / 'tab-prev' = 页签向左/向右切；'player' = 播放页从下方升起。
 */
const pageTransition = ref<'' | 'tab-next' | 'tab-prev' | 'player'>('');

/** 上一个主页分区路径，用来判断页签是往前还是往后切（决定入场方向）。 */
let lastSectionPath = '';

/**
 * 播放一次入场动画。
 *
 * ⚠️ 故意不用 `<Transition>` 包 `<KeepAlive>`：那样被缓存的页面会被当成
 * “离开”摘掉 DOM，再激活时不插回 —— 实测从「我的」返回主页后内容空白。
 * 这里只在容器上重新触发一次 CSS 动画，页面实例和滚动位置都不动。
 *
 * ⚠️ class 必须通过响应式绑定加，不能直接 `classList.add`：模板上已有 `:class`，
 * Vue 每次 patch 会把整个 className 重写一遍，手动加的 class 会被抹掉（实测动画从未生效）。
 */
const playPageTransition = async (kind: '' | 'tab-next' | 'tab-prev' | 'player') => {
  pageTransition.value = '';
  // 先让 Vue 把 class 去掉，再强制重排，最后重新打开，连点两个页签也能每次看到动画
  await nextTick();
  void contentRef.value?.offsetWidth;
  pageTransition.value = kind;
};

/** 根据页签在目录里的相对位置判断方向：往后切内容从右进、往前切从左进。 */
const resolveTabDirection = (path: string): 'tab-next' | 'tab-prev' => {
  const tabs = homeTabs.value;
  const from = tabs.findIndex((tab) => tab.path === lastSectionPath);
  const to = tabs.findIndex((tab) => tab.path === path);
  if (from < 0 || to < 0) return 'tab-next';
  return to < from ? 'tab-prev' : 'tab-next';
};

watch(
  () => route.path,
  (path) => {
    // 页签（主页分区 / 我的）横向切；播放页从下方升起；
    // 登录页、搜索结果、详情页这类入栈导航不做位移（它们有自己的交互语义）。
    if (route.name === 'player') {
      void playPageTransition('player');
    } else if (route.meta.section === 'main') {
      void playPageTransition(resolveTabDirection(path));
    } else if (route.name === 'profile') {
      void playPageTransition('tab-next');
    } else {
      pageTransition.value = '';
    }
    if (route.meta.section === 'main') lastSectionPath = path;
  },
);

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
      ref="contentRef"
      class="shell-content"
      :class="{
        'has-sub-tabs': subTabVisible,
        'is-fullscreen': !shellVisible,
        'is-tab-next': pageTransition === 'tab-next',
        'is-tab-prev': pageTransition === 'tab-prev',
        'is-player-switching': pageTransition === 'player',
      }"
      @touchstart="onShellTouchStart"
      @touchend="onShellTouchEnd"
      @touchcancel="onShellTouchCancel"
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

/*
 * 页签切换入场动画：淡入 + 轻微横移。
 *
 * 用 CSS 动画而不是 Vue <Transition>：见 App.vue 里的说明，Transition 与 KeepAlive
 * 叠加会让缓存页面空白。动画只改 opacity/transform，不参与布局，不会引起跳动；
 * 结束后 transform 回到 none，不影响页面内 absolute/fixed 定位（弹层已 Teleport 到 body）。
 */
.shell-content.is-tab-next {
  animation: shell-tab-in-next 200ms var(--ease-decelerate);
}

.shell-content.is-tab-prev {
  animation: shell-tab-in-prev 200ms var(--ease-decelerate);
}

/*
 * 播放页：从下方升起。全屏页本身是满铺背景，起始帧 opacity 为 0，
 * 所以位移期间不会露出外壳底色。
 */
.shell-content.is-player-switching {
  animation: shell-player-in 260ms var(--ease-decelerate);
}

@keyframes shell-player-in {
  from {
    opacity: 0;
    transform: translateY(28px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes shell-tab-in-next {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes shell-tab-in-prev {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 系统开了“减少动态效果”就不做位移 */
@media (prefers-reduced-motion: reduce) {
  .shell-content.is-tab-next,
  .shell-content.is-tab-prev,
  .shell-content.is-player-switching {
    animation: none;
  }
}
</style>
