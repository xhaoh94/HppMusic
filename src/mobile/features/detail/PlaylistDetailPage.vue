<script setup lang="ts">
/**
 * 歌单详情。
 *
 * 只做**公开歌单**的读取路径（详情 + 分页曲目 + 播放全部）。
 * 桌面端还有一大堆自有歌单的特殊处理（`getPlaylistTracksNew`、曲序自定义、
 * 封面分页补全、批量编辑……），那些依赖登录态与写入接口，属于 P3「我的」的范围，
 * 这里不预先铺进来 —— 铺了也测不到。
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import DetailHeader from '@mobile/components/DetailHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getPlaylistDetail, getPlaylistTracks } from '@/api/playlist';
import { mapPlaylistMeta, parsePlaylistTracks } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';

const route = useRoute();
const { playList, playSong } = usePlaybackActions();

const playlistId = computed(() => String(route.params.id ?? ''));
/**
 * ⚠️ 路由参数是 **global_collection_id**（形如 `collection_3_...`），不是数字 listid。
 * 内核的 `getPlaylistDetail` 与 `getPlaylistTracks` 打的是 `/v3/get_list_info` 与
 * `/pubsongs/v2/get_other_list_file_nofilt`，两者要的都是前者：
 * 传数字 id 分别得到「空 data」与 `20010 get other list file fail`。
 *
 * `/playlist/track/all` 实测能吃 pagesize=100。
 */
const PAGE_SIZE = 100;

const meta = ref<PlaylistMeta | null>(null);
const metaState = ref<'loading' | 'ready' | 'error'>('loading');
const metaError = ref('');

const songs = useInfiniteList<Song>(async (page) => {
  const response = await getPlaylistTracks(playlistId.value, page, PAGE_SIZE);
  const payload =
    response && typeof response === 'object' && 'data' in response
      ? (response as { data: unknown }).data
      : response;
  const parsed = parsePlaylistTracks(payload ?? response);
  // 返回数量不足一页说明没有更多了；被过滤掉的无效曲目也算"这一页已消费"
  const hasMore = parsed.songs.length + parsed.filteredCount >= PAGE_SIZE;
  return { items: parsed.songs, hasMore };
});

const loadMeta = async () => {
  metaState.value = 'loading';
  metaError.value = '';
  try {
    const response = await getPlaylistDetail(playlistId.value);
    const raw = (response as { data?: unknown[] })?.data?.[0];
    if (!raw) throw new Error('歌单不存在或已被删除');
    meta.value = mapPlaylistMeta(raw);
    metaState.value = 'ready';
  } catch (error) {
    logger.warn('PlaylistDetail', 'Load meta failed', error);
    metaError.value = error instanceof Error ? error.message : String(error);
    metaState.value = 'error';
  }
};

const playAll = async () => {
  const first = songs.items.value[0];
  if (!first) return;
  await playList(songs.items.value, {
    queueId: `queue:playlist:${playlistId.value}`,
    title: meta.value?.name || '歌单',
    subtitle: meta.value?.nickname || '',
    coverUrl: meta.value?.pic,
  });
};

const onSelectSong = async (song: Song) => {
  await playSong(song, songs.items.value, {
    queueId: `queue:playlist:${playlistId.value}`,
    title: meta.value?.name || '歌单',
    subtitle: meta.value?.nickname || '',
    coverUrl: meta.value?.pic,
  });
};

const stats = computed(() => {
  const count = meta.value?.count ?? songs.items.value.length;
  const playCount = Number(meta.value?.playCount ?? 0);
  const parts: string[] = [];
  if (count) parts.push(`${count} 首`);
  if (playCount > 0) parts.push(`${playCount} 播放`);
  return parts.join(' · ');
});

watch(
  playlistId,
  () => {
    void loadMeta();
    void songs.reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="detail-page">
    <PageHeader title="歌单" />

    <div class="detail-body scroll-y">
      <EmptyState v-if="metaState === 'error'" tone="error" title="加载失败" :description="metaError" />

      <template v-else>
        <DetailHeader
          :cover="meta?.pic"
          :title="meta?.name || (metaState === 'loading' ? '加载中…' : '歌单')"
          :subtitle="meta?.nickname || ''"
          :stats="stats"
          source="数据来自酷狗"
          :playable="songs.items.value.length > 0"
          @play-all="playAll"
        />

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

        <EmptyState
          v-else-if="songs.isLoading.value"
          tone="loading"
          title="正在加载曲目"
        />
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
