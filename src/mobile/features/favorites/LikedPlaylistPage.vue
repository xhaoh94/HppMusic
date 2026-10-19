<script setup lang="ts">
/**
 * 我喜欢（主页页签版）。
 *
 * 与「我的」里的「我的收藏」是**同一份数据**（内核 playlist store 的
 * `favorites`，服务端「我喜欢」歌单），布局对齐「随便听」：顶部搜索 + 播放全部，
 * 列表上方显示歌曲数量。
 */
import { computed, onActivated, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import SongRow from '@mobile/components/SongRow.vue';
import { useCurrentSongKey, useLocatePlayingSong } from '@mobile/composables/useCurrentSong';
import { songKeyOf } from '@mobile/utils/songKey';
import EmptyState from '@mobile/components/EmptyState.vue';
import ActionSheet from '@mobile/components/ActionSheet.vue';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';
import { iconClose, iconSearch } from '@mobile/icons';
import { filterSongsByQuery } from '@/utils/songList';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlaybackActions } from '@mobile/adapters/player';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';

// 组件名要与 App.vue 的 CACHED_PAGES 对上（对不上是静默失效：每次切页签都会重新挂载）
defineOptions({ name: 'LikedPlaylistPage' });

const router = useRouter();
const playlist = usePlaylistStore();
const toast = useToastStore();
const { playSong, playList, manualQueueMeta } = usePlaybackActions();

const loadError = ref('');
const searchQuery = ref('');

const songs = computed(() => playlist.favorites ?? []);
const displayedSongs = computed(() => filterSongsByQuery(songs.value, searchQuery.value));

// 当前播放标记 + 首次打开列表自动定位到正在播的那首
const { currentSongKey } = useCurrentSongKey();
useLocatePlayingSong(displayedSongs, currentSongKey);
const isLoading = computed(() => playlist.favoritesLoading && !playlist.favoritesLoaded);

const load = async (force = false) => {
  loadError.value = '';
  try {
    // 先确保「我喜欢」歌单信息就绪。缺了它 fetchLikedPlaylistSongs 会直接把收藏置空
    // 并标记成"已加载"，之后不带 force 的调用永远拿到空列表 —— 就是"有时候刷不出来"。
    await playlist.ensureLikedPlaylistReady();
    await playlist.fetchLikedPlaylistSongs(force);
  } catch (error) {
    logger.warn('LikedPlaylist', 'Load favorites failed', error);
    loadError.value = error instanceof Error ? error.message : String(error);
  }
};

const clearSearch = () => {
  searchQuery.value = '';
};

const onSelect = async (song: Song) => {
  await playSong(song, displayedSongs.value, { ...manualQueueMeta, title: '我喜欢' });
};

/** 播放全部：搜索时只播命中的那些（与列表所见一致） */
const playAll = async () => {
  const context = displayedSongs.value;
  if (!context.length) return;
  await playList(context, { ...manualQueueMeta, title: '我喜欢' });
};

const sheetOpen = ref(false);
const selected = ref<Song | null>(null);

const sheetItems = [
  { key: 'unfavorite', label: '取消收藏', description: '从「我喜欢」中移除这首歌', danger: true },
];

const onLongPress = (song: Song) => {
  selected.value = song;
  sheetOpen.value = true;
};

/**
 * 取消收藏。必须走 `ensureLikedPlaylistReady()` 拿 listId：收藏是服务端歌单
 * （「我喜欢」），移除操作是"从那个歌单里删掉这首歌"，光有歌曲对象不够。
 */
const onSheetSelect = async (key: string) => {
  const song = selected.value;
  selected.value = null;
  if (key !== 'unfavorite' || !song) return;

  try {
    const { listId } = await playlist.ensureLikedPlaylistReady();
    if (!listId) throw new Error('未找到「我喜欢」歌单，请稍后重试');
    await playlist.removeFromPlaylist(listId, song);
    toast.success('已取消收藏');
  } catch (error) {
    logger.warn('LikedPlaylist', 'Remove favorite failed', error);
    toast.danger(error instanceof Error ? error.message : '取消收藏失败');
  }
};

onMounted(() => {
  void load();
});

/**
 * 页签页被 KeepAlive 缓存了，回来不会重新挂载 —— 如果第一次加载时用户歌单还没就绪
 * （或网络失败），页面会一直停在空态。这里在「回到页面且确实是空」时补一次重试。
 * 首次激活跳过：那一趟 onMounted 已经在做，避免重复请求。
 */
let firstActivate = true;
onActivated(() => {
  if (firstActivate) {
    firstActivate = false;
    return;
  }
  if (songs.value.length || isLoading.value) return;
  void load();
});
</script>

<template>
  <div class="liked-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="displayedSongs" />
    <!-- 页签页不放标题：子页签栏已经写了名字，把高度留给搜索和列表 -->
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
          placeholder="在我喜欢中查找"
          aria-label="在我喜欢中查找"
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

      <button v-if="songs.length" type="button" class="play-all" @click="playAll">播放全部</button>
    </div>

    <div class="liked-body scroll-y">
      <EmptyState v-if="isLoading" tone="loading" title="正在加载收藏" />
      <EmptyState
        v-else-if="loadError"
        tone="error"
        title="收藏加载失败"
        :description="loadError"
        action-label="重试"
        @action="load(true)"
      />
      <EmptyState
        v-else-if="!songs.length"
        title="收藏还是空的"
        description="在播放页点心形图标就能把歌收进来"
        action-label="去听歌"
        @action="router.push({ name: 'home' })"
      />
      <EmptyState
        v-else-if="!displayedSongs.length"
        title="没有匹配的歌"
        description="换个关键词，或者清空搜索看看全部"
        action-label="清空搜索"
        @action="clearSearch"
      />
      <template v-else>
        <div class="list-head">
          <span class="list-count">{{ displayedSongs.length }} 首</span>
        </div>
        <SongRow
          v-for="(song, index) in displayedSongs"
          :key="`${song.id}-${index}`"
          :song="song"
          :active="songKeyOf(song) === currentSongKey"
          show-index
          :index="index"
          @select="onSelect"
          @longpress="onLongPress"
        />
      </template>
    </div>

    <ActionSheet
      v-model="sheetOpen"
      :subject="selected?.title"
      :items="sheetItems"
      @select="onSheetSelect"
    />
  </div>
</template>

<style scoped>
.liked-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
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

.play-all {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.liked-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
</style>
