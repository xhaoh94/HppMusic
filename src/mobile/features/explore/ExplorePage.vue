<script setup lang="ts">
/**
 * 探索。
 *
 * P2 接入歌单分类与推荐歌单（`@/api/music` 的分类接口）。P0 先占位，
 * 但保持完整的页面骨架（页头 + 滚动区 + 空态），接数据时只需要替换中间那段。
 */
import PageHeader from '@mobile/components/PageHeader.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
</script>

<template>
  <div class="explore-page">
    <PageHeader title="探索" />
    <div class="explore-body scroll-y">
      <EmptyState
        title="歌单分类即将上线"
        description="这里会展示按风格、场景、语种划分的歌单，以及个性化推荐。"
      />
    </div>
  </div>
</template>

<style scoped>
.explore-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.explore-body {
  flex: 1;
  min-height: 0;
}
</style>
