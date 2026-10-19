<script setup lang="ts">
/**
 * 我喜欢的歌单（主页页签版）。
 *
 * 与「我的」里的「我的收藏」是**同一份数据**（内核 playlist store 的
 * `favorites`，服务端「我喜欢」歌单），区别只在入口：这里是主页的一个页签，
 * 不需要返回箭头。收藏/取藏逻辑复用同一套，避免两处行为漂移。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import { useCurrentSongKey, useLocatePlayingSong } from '@mobile/composables/useCurrentSong';
import { songKeyOf } from '@mobile/utils/songKey';
import EmptyState from '@mobile/components/EmptyState.vue';
import ActionSheet from '@mobile/components/ActionSheet.vue';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlaybackActions } from '@mobile/adapters/player';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';

const router = useRouter();
const playlist = usePlaylistStore();
const toast = useToastStore();
const { playSong, playList, manualQueueMeta } = usePlaybackActions();

const loadError = ref('');

const songs = computed(() => playlist.favorites ?? []);

// 当前播放标记 + 首次打开列表自动定位到正在播的那首
const { currentSongKey } = useCurrentSongKey();
useLocatePlayingSong(songs, currentSongKey);
const isLoading = computed(() => playlist.favoritesLoading && !playlist.favoritesLoaded);

const load = async (force = false) => {
  loadError.value = '';
  try {
    await playlist.fetchLikedPlaylistSongs(force);
  } catch (error) {
    logger.warn('LikedPlaylist', 'Load favorites failed', error);
    loadError.value = error instanceof Error ? error.message : String(error);
  }
};

const onSelect = async (song: Song) => {
  await playSong(song, songs.value, { ...manualQueueMeta, title: '我喜欢的歌单' });
};

const playAll = async () => {
  if (!songs.value.length) return;
  await playList(songs.value, { ...manualQueueMeta, title: '我喜欢的歌单' });
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
</script>

<template>
  <div class="liked-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="songs" />
    <!-- 页签页不需要返回箭头（back 关掉：自动判断在页签场景会露出多余的箭头） -->
    <PageHeader title="我喜欢的歌单" :back="false">
      <template #actions>
        <button v-if="songs.length" type="button" class="header-action" @click="playAll">
          播放全部
        </button>
      </template>
    </PageHeader>

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
      <template v-else>
        <SongRow
          v-for="(song, index) in songs"
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

.liked-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.header-action {
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
