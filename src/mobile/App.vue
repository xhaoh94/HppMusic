<script setup lang="ts">
/**
 * 应用根组件。
 *
 * 只做三件事：把当前路由页面塞进外壳、全局挂 Toast 宿主、全局挂安全验证浮层。
 *
 * 注意这里**不再像旧方案那样 mount 第二个 Vue app** 来当外壳：那会让外壳与页面
 * 分属两棵组件树（共享 pinia/router 但各自独立渲染），路由切换时外壳的重渲染
 * 时机与页面不同步，滑动手势、过渡动画都会打架。外壳就是普通的父组件。
 *
 * 验证浮层挂在这里而不是登录页里：风控挑战可能在任何请求上触发（播放、加歌单……），
 * 挂在根上才能保证「任何被挂起的请求都有出口」。
 */
import AppShell from '@mobile/shell/AppShell.vue';
import ToastHost from '@mobile/components/ToastHost.vue';
import VerificationSheet from '@mobile/components/VerificationSheet.vue';
</script>

<template>
  <AppShell>
    <router-view />
  </AppShell>
  <ToastHost />
  <VerificationSheet />
</template>
