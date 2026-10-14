<script setup lang="ts">
/**
 * 每日推荐。
 *
 * 从首页独立成一页（首页磁贴「每日推荐」跳这里）。首页是"磁贴 + 歌单网格"的结构，
 * 把 30 首歌曲列表塞进首页会让首屏长到看不到歌单 —— 参考产品也是分开的。
 *
 * 数据链路（本页是唯一一条"登录 → 设备注册 → 加密请求 → 解密 → 映射"的完整链路，
 * 也是最早跑通的一条）：`getEverydayRecommend()` + `extractList` + `mapTopSong`。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getEverydayRecommend } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';

const router = useRouter();
const { playSong, playList } = usePlaybackActions();

type LoadState = 'loading' | 'ready' | 'error';

const state = ref<LoadState>('loading');
const songs = ref<Song[]>([]);
const failureReason = ref('');

const load = async () => {
  state.value = 'loading';
  failureReason.value = '';
  try {
    const response = await getEverydayRecommend();
    songs.value = (extractList(response) as unknown[]).map((item) => mapTopSong(item));
    state.value = 'ready';
    logger.info('Recommend', 'Daily recommend loaded:', songs.value.length);
  } catch (error) {
    logger.warn('Recommend', 'Daily recommend failed', error);
    failureReason.value = error instanceof Error ? error.message : String(error);
    state.value = 'error';
  }
};

const queueMeta = { queueId: 'queue:mobile-daily', title: '每日推荐', subtitle: '' };

const onSelect = async (song: Song) => {
  await playSong(song, songs.value, queueMeta);
};

const playAll = async () => {
  if (!songs.value.length) return;
  await playList(songs.value, queueMeta);
};

onMounted(() => void load());
</script>

<template>
  <div class="recommend-page">
    <PageHeader title="每日推荐">
      <template #actions>
        <button type="button" class="header-action" @click="load">换一批</button>
      </template>
    </PageHeader>

    <div class="page-body scroll-y">
      <EmptyState v-if="state === 'loading'" tone="loading" title="正在加载" />
      <EmptyState
        v-else-if="state === 'error'"
        tone="error"
        title="加载失败"
        :description="failureReason"
        action-label="重试"
        @action="load"
      />
      <EmptyState
        v-else-if="!songs.length"
        title="今天还没有推荐"
        description="稍后再试试，或者先搜索你想听的歌"
        action-label="去搜索"
        @action="router.push({ name: 'search' })"
      />

      <template v-else>
        <div class="list-head">
          <span class="list-count">共 {{ songs.length }} 首</span>
          <button type="button" class="play-all" @click="playAll">播放全部</button>
        </div>
        <SongRow
          v-for="(song, index) in songs"
          :key="`${song.id}-${index}`"
          :song="song"
          show-index
          :index="index"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.recommend-page {
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

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-4) var(--sp-3);
}

.list-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.play-all {
  min-height: 34px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}
</style>
