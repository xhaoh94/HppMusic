<script setup lang="ts">
/**
 * 404。
 *
 * 用 hash 路由后唯一会落到这里的场景是「旧版本残留的书签 / 手动改 hash」，
 * 所以只给一句人话 + 回主页，不做花哨的插画。
 */
import { useRouter } from 'vue-router';
import EmptyState from '@mobile/components/EmptyState.vue';

const router = useRouter();
</script>

<template>
  <div class="not-found">
    <EmptyState
      tone="empty"
      title="页面不存在"
      description="链接可能已失效，回到主页继续听歌吧。"
      action-label="回到主页"
      @action="router.replace({ name: 'home' })"
    />
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--safe-top) var(--sp-4) var(--safe-bottom);
}
</style>
