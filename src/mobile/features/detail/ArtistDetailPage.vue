<script setup lang="ts">
/**
 * 歌手详情。
 *
 * 比歌单/专辑多一个**排序切换**（热门 / 最新）：歌手动辄几百首，
 * 不给排序的话用户想找新歌只能一路翻到底。
 *
 * 曲目用新版接口 `getArtistSongsV2`（每条带作者列表，支持多歌手合唱），
 * 对应 `mapArtistSongV2` —— 旧接口的 `mapArtistSong` 需要额外传入 artistId
 * 才能补全歌手信息，能不用就不用。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import DetailHeader from '@mobile/components/DetailHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getArtistDetail, getArtistSongsV2 } from '@/api/artist';
import { extractFirstObject, extractList } from '@/utils/extractors';
import { mapArtistDetailMeta, mapArtistSongV2 } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { ArtistMeta } from '@/models/artist';
import type { Song } from '@/models/song';

const route = useRoute();
const { playList, playSong } = usePlaybackActions();

const artistId = computed(() => String(route.params.id ?? ''));
/** `/artist/audios/new` 实测能吃 100（接口封装里也把 pagesize 限在 100） */
const PAGE_SIZE = 100;

const meta = ref<ArtistMeta | null>(null);
const metaState = ref<'loading' | 'ready' | 'error'>('loading');
const metaError = ref('');

const sort = ref<'hot' | 'new'>('hot');

const songs = useInfiniteList<Song>(async (page) => {
  // sort 在调用时读取：切换排序会触发 reload
  const response = await getArtistSongsV2(artistId.value, page, PAGE_SIZE, sort.value);
  const items = extractList(response).map((item) => mapArtistSongV2(item));
  return { items, hasMore: items.length >= PAGE_SIZE };
});

const loadMeta = async () => {
  metaState.value = 'loading';
  metaError.value = '';
  try {
    const response = await getArtistDetail(artistId.value);
    const raw = extractFirstObject(response);
    if (!raw) throw new Error('歌手不存在');
    meta.value = mapArtistDetailMeta(raw);
    metaState.value = 'ready';
  } catch (error) {
    logger.warn('ArtistDetail', 'Load meta failed', error);
    metaError.value = error instanceof Error ? error.message : String(error);
    metaState.value = 'error';
  }
};

const queueMeta = () => ({
  queueId: `queue:artist:${artistId.value}`,
  title: meta.value?.name || '歌手',
  subtitle: '',
  coverUrl: meta.value?.pic,
});

const playAll = async () => {
  if (!songs.items.value.length) return;
  await playList(songs.items.value, queueMeta());
};

const onSelectSong = async (song: Song) => {
  await playSong(song, songs.items.value, queueMeta());
};

const stats = computed(() => {
  const parts: string[] = [];
  if (meta.value?.songCount) parts.push(`${meta.value.songCount} 首歌`);
  if (meta.value?.albumCount) parts.push(`${meta.value.albumCount} 张专辑`);
  if (meta.value?.fansCount) parts.push(`${meta.value.fansCount} 粉丝`);
  return parts.join(' · ');
});

watch(
  artistId,
  () => {
    void loadMeta();
    void songs.reload();
  },
  { immediate: true },
);

watch(sort, () => void songs.reload());
</script>

<template>
  <div class="detail-page">
    <PageHeader title="歌手" />

    <div class="detail-body scroll-y">
      <EmptyState v-if="metaState === 'error'" tone="error" title="加载失败" :description="metaError" />

      <template v-else>
        <DetailHeader
          round
          :cover="meta?.pic"
          :title="meta?.name || (metaState === 'loading' ? '加载中…' : '歌手')"
          :stats="stats"
          :playable="songs.items.value.length > 0"
          @play-all="playAll"
        />

        <div class="sort-row">
          <button
            v-for="option in [
              { value: 'hot' as const, label: '热门' },
              { value: 'new' as const, label: '最新' },
            ]"
            :key="option.value"
            type="button"
            class="sort-button"
            :class="{ 'is-active': sort === option.value }"
            @click="sort = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <SongRow
          v-for="(song, index) in songs.items.value"
          :key="`${song.id}-${index}`"
          :song="song"
          show-index
          :index="index"
          @select="onSelectSong"
        />

        <div v-if="songs.items.value.length > 0" :ref="songs.sentinel" class="sentinel">
          <template v-if="songs.isLoadingMore.value">正在加载更多…</template>
          <template v-else-if="songs.error.value">
            <button type="button" class="retry" @click="songs.retry()">加载失败，点击重试</button>
          </template>
          <template v-else-if="!songs.hasMore.value">没有更多了</template>
        </div>

        <EmptyState v-else-if="songs.isLoading.value" tone="loading" title="正在加载曲目" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.sort-row {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-3);
}

.sort-button {
  min-height: 34px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.sort-button.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: var(--weight-semibold);
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
