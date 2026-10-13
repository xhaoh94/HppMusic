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
import { onMounted } from 'vue';
import AppShell from '@mobile/shell/AppShell.vue';
import ToastHost from '@mobile/components/ToastHost.vue';
import VerificationSheet from '@mobile/components/VerificationSheet.vue';
import AuthExpiredSheet from '@mobile/components/AuthExpiredSheet.vue';
import { bootstrapPlayer } from '@mobile/adapters/player';
import logger from '@/utils/logger';

onMounted(() => {
  void bootstrapPlayer().catch((error) => {
    // 启动页会自己展示失败原因；这里只记日志，不阻断界面
    logger.warn('MobileApp', 'Player bootstrap failed on mount', error);
  });
});
</script>

<template>
  <AppShell>
    <router-view />
  </AppShell>
  <ToastHost />
  <VerificationSheet />
  <AuthExpiredSheet />
</template>
