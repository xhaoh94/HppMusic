<script setup lang="ts">
/**
 * 专辑详情。
 *
 * 与歌单详情同一形状（头部 + 分页曲目），差别只在接口与映射函数：
 * 专辑的曲目接口返回的是 `data.info` 之类的层级，用 `extractList` 统一抽取
 * （它内部已经处理了多级候选），再逐条 `mapAlbumSong`。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import DetailHeader from '@mobile/components/DetailHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useCurrentSongKey, useLocatePlayingSong } from '@mobile/composables/useCurrentSong';
import { songKeyOf } from '@mobile/utils/songKey';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getAlbumDetail, getAlbumSongs } from '@/api/album';
import { extractFirstObject, extractList } from '@/utils/extractors';
import { mapAlbumDetailMeta, mapAlbumSong } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { AlbumMeta } from '@/models/album';
import type { Song } from '@/models/song';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';

const route = useRoute();
const { playList, playSong } = usePlaybackActions();

const albumId = computed(() => String(route.params.id ?? ''));
/**
 * ⚠️ 50 是实测出来的上限，不是随便选的。
 *
 * `/album/songs` 在 `pagesize=100` 时直接返回 **502**（不是空列表，是错误），
 * `pagesize=50` 正常、`pagesize=60` 就 502 了。上游没有文档说明这个限制，
 * 而且**各接口的上限还不一样**（实测：`/playlist/track/all` 与
 * `/artist/audios/new` 能吃 100，`/album/songs` 只能到 50）。
 * 症状很有欺骗性：没报错、只是列表永远为空。
 */
const PAGE_SIZE = 50;

const meta = ref<AlbumMeta | null>(null);
const metaState = ref<'loading' | 'ready' | 'error'>('loading');
const metaError = ref('');

const songs = useInfiniteList<Song>(async (page) => {
  const response = await getAlbumSongs(albumId.value, page, PAGE_SIZE);
  const items = extractList(response).map((item) => mapAlbumSong(item));
  return { items, hasMore: items.length >= PAGE_SIZE };
});

// 当前播放标记 + 首次打开列表自动定位到正在播的那首
const { currentSongKey } = useCurrentSongKey();
useLocatePlayingSong(songs.items, currentSongKey);

const loadMeta = async () => {
  metaState.value = 'loading';
  metaError.value = '';
  try {
    const response = await getAlbumDetail(albumId.value);
    const raw = extractFirstObject(response);
    if (!raw) throw new Error('专辑不存在或已被删除');
    meta.value = mapAlbumDetailMeta(raw);
    metaState.value = 'ready';
  } catch (error) {
    logger.warn('AlbumDetail', 'Load meta failed', error);
    metaError.value = error instanceof Error ? error.message : String(error);
    metaState.value = 'error';
  }
};

const queueMeta = () => ({
  queueId: `queue:album:${albumId.value}`,
  title: meta.value?.name || '专辑',
  subtitle: meta.value?.singerName || '',
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
  if (meta.value?.singerName) parts.push(meta.value.singerName);
  if (meta.value?.publishTime) parts.push(String(meta.value.publishTime));
  if (meta.value?.songCount) parts.push(`${meta.value.songCount} 首`);
  return parts.join(' · ');
});

watch(
  albumId,
  () => {
    void loadMeta();
    void songs.reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="detail-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="songs.items.value" />
    <PageHeader title="专辑" />

    <div class="detail-body scroll-y">
      <EmptyState v-if="metaState === 'error'" tone="error" title="加载失败" :description="metaError" />

      <template v-else>
        <DetailHeader
          :cover="meta?.pic"
          :title="meta?.name || (metaState === 'loading' ? '加载中…' : '专辑')"
          :subtitle="meta?.singerName || ''"
          :stats="stats"
          source="数据来自酷狗"
          :playable="songs.items.value.length > 0"
          @play-all="playAll"
        />

        <SongRow
          v-for="(song, index) in songs.items.value"
          :key="`${song.id}-${index}`"
          :song="song"
          :active="songKeyOf(song) === currentSongKey"
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
  /* 定位按钮的绝对定位参照 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
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
