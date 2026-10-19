<script setup lang="ts">
/**
 * 应用根组件。
 *
 * 只做四件事：把当前路由页面塞进外壳、全局挂 Toast 宿主、全局挂安全验证浮层，
 * 以及**应用级触发播放内核的初始化**。
 *
 * 注意这里**不再像旧方案那样 mount 第二个 Vue app** 来当外壳：那会让外壳与页面
 * 分属两棵组件树（共享 pinia/router 但各自独立渲染），路由切换时外壳的重渲染
 * 时机与页面不同步，滑动手势、过渡动画都会打架。外壳就是普通的父组件。
 *
 * ⚠️ 为什么 bootstrapPlayer 要挂在这里，而不是只由启动页调：
 * 移动端的深链接是真实场景（分享链、`hppmusic://` 唤起、通知栏点击），
 * hash 直达时**根本不会经过启动页**——只挂在启动页上的话，
 * 播放内核不初始化、本地播放历史不水合，用户看到的是“历史永远空、
 * 播放按钮没反应”。`bootstrapPlayer()` 是幂等的（内部缓存同一个 promise），
 * 启动页仍然 await 它以保证“进主界面前就绪”，这里只是兼底处理深链接路径。
 */
import { onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppShell from '@mobile/shell/AppShell.vue';
import ToastHost from '@mobile/components/ToastHost.vue';
import VerificationSheet from '@mobile/components/VerificationSheet.vue';
import AuthExpiredSheet from '@mobile/components/AuthExpiredSheet.vue';
import { bootstrapPlayer } from '@mobile/adapters/player';
import { useKeepScroll } from '@mobile/composables/useKeepScroll';
import { usePlayerStore } from '@/stores/player';
import logger from '@/utils/logger';

const route = useRoute();
const router = useRouter();

// 记/恢复各页面的滚动位置（KeepAlive 只保组件状态，保不住 scrollTop）
useKeepScroll(router);

/**
 * 把播放失败提示记进日志。
 *
 * 内核那条提示本身**不写任何日志**（`showPlaybackNotice` 只写状态，toast 也不打日志），
 * 于是设备上出现"播放失败"时，logcat 里看不到任何原因 —— 排查启动续播失败就卡在这里。
 * 移动端补这一条，把 code / reason / trackId 落到 logcat。
 */
watch(
  () => usePlayerStore().playbackNotice,
  (notice) => {
    if (!notice) return;
    logger.warn('MobilePlayer', 'Playback notice', {
      code: notice.code,
      title: notice.title,
      reason: notice.reason,
      trackId: notice.trackId,
    });
  },
);

/**
 * 走 KeepAlive 的页面名（对应各页 `defineOptions({ name })`）。
 *
 * 这些是主界面页签页：内容变化很慢（每日推荐 / AI 推荐 / 排行榜都是日更级），
 * 而用户会在它们与播放页之间反复来回。不缓存的话每次返回都要重新拉一遍
 * ——列表闪一下、滚动位置也没了，明明只是想回去接着看。
 *
 * 详情页/播放页**不在名单里**：每次进入都该是新内容。
 *
 * 用 `:include` 而不是在 KeepAlive 里写 `v-if`：后者会打乱组件切换
 * ——实测切页签后**子页签高亮变了、渲染的却还是上一个页**。
 */
const CACHED_PAGES = [
  'HomePage', 'FreeListenPage', 'ListenTogetherPage', 'ExplorePage',
  'PersonalFmPage', 'PurchasedPage',
];

// 仅为让路由变化触发重渲染：KeepAlive 自己会处理缓存，这里只需要它在切页时生效
void route;

onMounted(() => {
  void bootstrapPlayer().catch((error) => {
    // 启动页会自己展示失败原因；这里只记日志，不阻断界面
    logger.warn('MobileApp', 'Player bootstrap failed on mount', error);
  });
});
</script>

<template>
  <AppShell>
    <!--
      不在名单里的页面仍然正常渲染，只是不进缓存。
      组件名由各页的 `defineOptions({ name })` 显式声明：`<script setup>` 的
      文件名推导不算可靠（改名/嵌套目录都会影响），而名单对不上时是**静默失效**
      （缓存没了，但不报错），所以宁可写死。
    -->
    <router-view v-slot="{ Component }">
      <KeepAlive :include="CACHED_PAGES">
        <component :is="Component" />
      </KeepAlive>
    </router-view>
  </AppShell>
  <ToastHost />
  <VerificationSheet />
  <AuthExpiredSheet />
</template>
