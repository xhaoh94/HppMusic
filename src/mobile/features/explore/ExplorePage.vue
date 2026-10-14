<script setup lang="ts">
/**
 * 探索。
 *
 * 不放 PageHeader：「主页」分区下的页面顶部已经有子页签栏表明位置，
 * 再顶一行标题是重复信息（用户对随便听页反馈过同样的问题，这里统一）。
 *
 * P2 接入歌单分类与推荐歌单（`@/api/music` 的分类接口）。P0 先占位，
 * 但保持完整的页面骨架（滚动区 + 空态），接数据时只需要替换中间那段。
 */
import EmptyState from '@mobile/components/EmptyState.vue';
</script>

<template>
  <div class="explore-page scroll-y">
    <EmptyState
      title="歌单分类即将上线"
      description="这里会展示按风格、场景、语种划分的歌单，以及个性化推荐。"
    />
  </div>
</template>

<style scoped>
.explore-page {
  height: 100%;
}
</style>
