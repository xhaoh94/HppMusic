<script setup lang="ts">
/**
 * 榜单详情（某张榜单的曲目）。
 *
 * ⚠️ 榜单曲目**不在** `getRanks()` 的响应里（那里的 `info[].list` 是空的），
 * 必须用 `getRankSongs(rankid)` 单独取。这一点不知道的话会把"空列表"
 * 误判成接口坏了。
 *
 * `getRankSongs` 的默认 `pagesize` 是 100，一次能拿一整页；用
 * `useInfiniteList` 翻页即可。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getRanks, getRankSongs } from '@/api/playlist';
import { extractList } from '@/utils/extractors';
import { mapRankSong, mapRankMeta } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { RankMeta } from '@/models/rank';
import type { Song } from '@/models/song';

const route = useRoute();
const { playSong, playList } = usePlaybackActions();

const rankId = computed(() => String(route.params.id ?? ''));
const PAGE_SIZE = 100;

const meta = ref<RankMeta | null>(null);

const songs = useInfiniteList<Song>(async (page) => {
  const response = await getRankSongs(Number(rankId.value), page, PAGE_SIZE);
  const items = extractList(response).map((item) => mapRankSong(item));
  return { items, hasMore: items.length >= PAGE_SIZE };
});

/**
 * 榜单元信息：`getRanks()` 里翻出当前这张。
 * 单独请求一个"榜单详情"接口并不存在，而榜单列表本来就不大（几十条），
 * 直接用列表里那一条即可。
 */
const loadMeta = async () => {
  try {
    const response = await getRanks();
    const list = extractList(response).map((item) => mapRankMeta(item));
    meta.value = list.find((item) => String(item.id) === rankId.value) ?? null;
  } catch (error) {
    logger.warn('RankDetail', 'Load rank meta failed', error);
  }
};

const queueMeta = () => ({
  queueId: `queue:rank:${rankId.value}`,
  title: meta.value?.name || '排行榜',
  subtitle: meta.value?.updateFrequency || '',
  coverUrl: meta.value?.pic,
});

const onSelect = async (song: Song) => {
  await playSong(song, songs.items.value, queueMeta());
};

const playAll = async () => {
  if (!songs.items.value.length) return;
  await playList(songs.items.value, queueMeta());
};

watch(
  rankId,
  () => {
    void loadMeta();
    void songs.reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="rank-page">
    <PageHeader :title="meta?.name || '排行榜'">
      <template #actions>
        <button
          v-if="songs.items.value.length"
          type="button"
          class="header-action"
          @click="playAll"
        >
          播放全部
        </button>
      </template>
    </PageHeader>

    <div class="page-body scroll-y">
      <p v-if="meta?.updateFrequency" class="rank-meta">{{ meta.updateFrequency }}</p>

      <SongRow
        v-for="(song, index) in songs.items.value"
        :key="`${song.id}-${index}`"
        :song="song"
        show-index
        :index="index"
        @select="onSelect"
      />

      <EmptyState v-if="songs.isLoading.value && !songs.items.value.length" tone="loading" title="正在加载曲目" />
      <EmptyState
        v-else-if="songs.error.value && !songs.items.value.length"
        tone="error"
        title="曲目加载失败"
        :description="songs.error.value"
        action-label="重试"
        @action="songs.reload()"
      />

      <div v-if="songs.items.value.length" :ref="songs.sentinel" class="sentinel">
        <template v-if="songs.isLoadingMore.value">正在加载更多…</template>
        <template v-else-if="songs.error.value">
          <button type="button" class="retry" @click="songs.retry()">加载失败，点击重试</button>
        </template>
        <template v-else-if="!songs.hasMore.value">没有更多了</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rank-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  min-height: 34px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.rank-meta {
  margin: 0;
  padding: 0 var(--sp-4) var(--sp-2);
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.retry {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
