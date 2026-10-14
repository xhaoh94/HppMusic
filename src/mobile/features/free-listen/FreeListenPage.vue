<script setup lang="ts">
/**
 * 免费听。
 *
 * 数据来自 `/ai/recommend/song`（AI 推荐免费歌曲）—— 是首页「免费听」子页签的落地页。
 *
 * ## 三个从上游继承下来的处理（都不是可有可无的）
 *
 * 1. **去重**：这个接口会返回重复歌曲（同一首多次出现）。上游用
 *    `mixSongId || hash || id` 做 key 过滤，照搬 —— 不去重时列表里会看到
 *    连着好几首一模一样的歌。
 * 2. **刷新时清空搜索词**：用户点了"换一批"却发现列表没变（因为搜索词还在过滤），
 *    这是很常见的误解来源。
 * 3. **代次 + 会话检查**：请求是异步的，期间用户可能换账号或连点刷新；
 *    不检查的话旧账号的数据会写回当前列表。
 *
 * ## 页面内搜索
 *
 * 免费听一次给几十首，滑动找歌很低效，所以页内放一个过滤框
 * （只是**本地过滤**，不触发搜索接口 —— 它是"在结果里找"，不是"搜全网"）。
 */
import { computed, onMounted, ref } from 'vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { Icon } from '@iconify/vue';
import { iconClose, iconRefresh, iconSearch } from '@mobile/icons';
import { usePlaybackActions } from '@mobile/adapters/player';
import { getFreeListenSongs } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import { filterSongsByQuery } from '@/utils/songList';
import { captureUserSession } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';

const user = useUserStore();
const { playSong, playList } = usePlaybackActions();

const QUEUE_META = { queueId: 'queue:free-listen', title: '免费听', subtitle: '' };

const songs = ref<Song[]>([]);
const loading = ref(true);
const loadError = ref('');
const searchQuery = ref('');

/** 已收录的歌曲 key，用于跨批次去重 */
const seenKeys = new Set<string>();
let loadGeneration = 0;

const songKey = (song: Song) => String(song.mixSongId || song.hash || song.id || '');

const displayedSongs = computed(() => filterSongsByQuery(songs.value, searchQuery.value));

const collectSongs = (payload: unknown): Song[] => {
  const batch: Song[] = [];
  for (const item of extractList(payload)) {
    const song = mapTopSong(item);
    const key = songKey(song);
    if (!key || !song.id || seenKeys.has(key)) continue;
    seenKeys.add(key);
    batch.push(song);
  }
  return batch;
};

const load = async () => {
  const generation = ++loadGeneration;
  const isSessionCurrent = captureUserSession(user);
  loading.value = true;
  loadError.value = '';
  seenKeys.clear();
  try {
    const payload = await getFreeListenSongs();
    if (generation !== loadGeneration || !isSessionCurrent()) return;
    songs.value = collectSongs(payload);
  } catch (error) {
    if (generation !== loadGeneration || !isSessionCurrent()) return;
    logger.warn('FreeListen', 'Load failed', error);
    songs.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
};

/** 换一批：连搜索词一起清掉，否则列表看起来"没变化" */
const refresh = async () => {
  searchQuery.value = '';
  await load();
};

const clearSearch = () => {
  searchQuery.value = '';
};

const onSelect = async (song: Song) => {
  const context = displayedSongs.value;
  await playSong(song, context, QUEUE_META);
};

const playAll = async () => {
  const context = displayedSongs.value;
  if (!context.length) return;
  await playList(context, QUEUE_META);
};

onMounted(() => void load());
</script>

<template>
  <div class="free-page">
    <!--
      不放 PageHeader：页面已经在「主页」分区下，顶部子页签栏已经表明当前位置，
      再顶一行「‹ 免费听」是重复信息（用户直接反馈过）。
      原本在 PageHeader 里的「换一批」挪到搜索栏右侧，省下一整行高度。
    -->
    <div class="toolbar">
      <div class="search-bar">
        <Icon :icon="iconSearch" width="16" height="16" class="search-icon" />
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          enterkeyhint="search"
          autocapitalize="off"
          autocomplete="off"
          placeholder="在本批推荐中查找"
          aria-label="在本批推荐中查找"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="clear-button"
          aria-label="清空"
          @click="clearSearch"
        >
          <Icon :icon="iconClose" width="15" height="15" />
        </button>
      </div>

      <button
        type="button"
        class="refresh-button"
        :disabled="loading"
        aria-label="换一批"
        @click="refresh"
      >
        <Icon :icon="iconRefresh" width="18" height="18" :class="{ spin: loading }" />
      </button>
    </div>

    <div class="page-body scroll-y">
      <EmptyState v-if="loading && !songs.length" tone="loading" title="正在加载免费歌曲" />
      <EmptyState
        v-else-if="loadError"
        tone="error"
        title="加载失败"
        :description="loadError"
        action-label="重试"
        @action="load"
      />
      <EmptyState
        v-else-if="!songs.length"
        title="暂时没有免费歌曲"
        description="稍后再试，或者点右上角换一批"
      />
      <EmptyState
        v-else-if="!displayedSongs.length"
        title="本批推荐里没有匹配的歌"
        description="换个关键词，或者清空搜索看看全部"
        action-label="清空搜索"
        @action="clearSearch"
      />

      <template v-else>
        <div class="list-head">
          <span class="list-count">{{ displayedSongs.length }} 首</span>
          <button type="button" class="play-all" @click="playAll">播放全部</button>
        </div>
        <SongRow
          v-for="(song, index) in displayedSongs"
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
.free-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.header-action:disabled {
  opacity: 0.5;
}

.header-action:active:not(:disabled) {
  background: var(--fill-muted);
}

/* 搜索栏 + 换一批：同一行 */
.toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4) var(--sp-2);
}

.search-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 40px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
}

.refresh-button {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.refresh-button:disabled {
  opacity: 0.5;
}

.refresh-button:active:not(:disabled) {
  background: var(--fill-muted);
}

.search-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  font-size: var(--font-sm);
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.clear-button {
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-tertiary);
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
  padding: 0 var(--sp-4) var(--sp-2);
}

.list-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.play-all {
  min-height: 32px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
