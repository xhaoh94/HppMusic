<script setup lang="ts">
/**
 * 排行榜列表。
 *
 * `getRanks()` 返回的榜单**不含曲目**（`info[].list` 是空的），曲目要进详情页后
 * 再用 `getRankSongs(rankid)` 单独取 —— 这一点在首页磁贴跳转时就该知道，
 * 否则会误以为"榜单接口坏了"。
 *
 * 榜单会按 `group`（类型名）分组展示：上游一次给几十个榜
 * （TOP500 / 飙升榜 / 各语种 / 各曲风……），平铺一列会很难找。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { getRanks } from '@/api/playlist';
import { extractList } from '@/utils/extractors';
import { mapRankMeta } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { RankMeta } from '@/models/rank';

const router = useRouter();

type LoadState = 'loading' | 'ready' | 'error';

const state = ref<LoadState>('loading');
const failureReason = ref('');
const ranks = ref<RankMeta[]>([]);

const grouped = computed(() => {
  const groups = new Map<string, RankMeta[]>();
  for (const rank of ranks.value) {
    const key = rank.group || rank.rankTypeName || '全部榜单';
    const list = groups.get(key) ?? [];
    list.push(rank);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
});

const load = async () => {
  state.value = 'loading';
  failureReason.value = '';
  try {
    const response = await getRanks();
    ranks.value = extractList(response).map((item) => mapRankMeta(item));
    state.value = 'ready';
  } catch (error) {
    logger.warn('Ranking', 'Load ranks failed', error);
    failureReason.value = error instanceof Error ? error.message : String(error);
    state.value = 'error';
  }
};

const openRank = (rank: RankMeta) => {
  if (!rank.id) return;
  void router.push({ name: 'rank-detail', params: { id: String(rank.id) } });
};

const subtitleOf = (rank: RankMeta) =>
  rank.updateFrequency || rank.rankTypeName || rank.description || '';

onMounted(() => void load());
</script>

<template>
  <div class="ranking-page">
    <PageHeader title="排行榜" />

    <div class="page-body scroll-y">
      <EmptyState v-if="state === 'loading'" tone="loading" title="正在加载榜单" />
      <EmptyState
        v-else-if="state === 'error'"
        tone="error"
        title="榜单加载失败"
        :description="failureReason"
        action-label="重试"
        @action="load"
      />
      <EmptyState v-else-if="!ranks.length" title="暂时没有榜单" />

      <template v-else>
        <section v-for="group in grouped" :key="group.name" class="group">
          <h2 class="group-title">{{ group.name }}</h2>
          <div class="grid">
            <MediaCard
              v-for="rank in group.items"
              :key="rank.id"
              :cover="rank.pic"
              :title="rank.name"
              :subtitle="subtitleOf(rank)"
              @select="openRank(rank)"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ranking-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.group {
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
}

.group-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4) var(--sp-3);
}
</style>
