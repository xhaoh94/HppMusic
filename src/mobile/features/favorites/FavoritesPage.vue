<script setup lang="ts">
/**
 * 我的收藏（红心歌单）。
 *
 * 数据来自内核 playlist store 的 `favorites`（`fetchLikedPlaylistSongs` 从服务端
 * 「我喜欢」歌单拉取），**需要登录**。未登录时由路由守卫拦在外面，
 * 所以这里不必处理"未登录"分支，但要处理接口失败（token 失效/网络）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import ActionSheet from '@mobile/components/ActionSheet.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlaybackActions } from '@mobile/adapters/player';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';

const router = useRouter();
const playlist = usePlaylistStore();
const toast = useToastStore();
const { playSong, playList, manualQueueMeta } = usePlaybackActions();

const loadError = ref('');

const songs = computed(() => playlist.favorites ?? []);
const isLoading = computed(() => playlist.favoritesLoading && !playlist.favoritesLoaded);

const load = async (force = false) => {
  loadError.value = '';
  try {
    await playlist.fetchLikedPlaylistSongs(force);
  } catch (error) {
    logger.warn('Favorites', 'Load favorites failed', error);
    loadError.value = error instanceof Error ? error.message : String(error);
  }
};

const onSelect = async (song: Song) => {
  await playSong(song, songs.value, { ...manualQueueMeta, title: '我的收藏' });
};

const playAll = async () => {
  if (!songs.value.length) return;
  await playList(songs.value, { ...manualQueueMeta, title: '我的收藏' });
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
 * 取消收藏。
 *
 * ⚠️ 必须走 `ensureLikedPlaylistReady()` 拿 listId：收藏是一个**服务端歌单**
 * （「我喜欢」），移除操作是"从那个歌单里删掉这首歌"，光有歌曲对象不够。
 * 该动作内部会按需拉取用户歌单，所以这里不需要自己先 fetchUserPlaylists。
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
    logger.warn('Favorites', 'Remove favorite failed', error);
    toast.danger(error instanceof Error ? error.message : '取消收藏失败');
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="favorites-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="songs" />
    <PageHeader title="我的收藏">
      <template #actions>
        <button
          v-if="songs.length"
          type="button"
          class="header-action"
          @click="playAll"
        >
          播放全部
        </button>
      </template>
    </PageHeader>

    <div class="favorites-body scroll-y">
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
        <div class="song-list">
          <SongRow
            v-for="(song, index) in songs"
            :key="`${song.id}-${index}`"
            :song="song"
            @select="onSelect"
            @longpress="onLongPress"
          />
        </div>
        <p class="list-hint">长按可以取消收藏</p>
      </template>
    </div>
  </div>

  <ActionSheet
    v-model="sheetOpen"
    :subject="selected?.title"
    :items="sheetItems"
    @select="onSheetSelect"
  />
</template>

<style scoped>
.favorites-page {
  /* 定位按钮的绝对定位参照 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  min-height: 36px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
}

.favorites-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.song-list {
  display: flex;
  flex-direction: column;
}

.list-hint {
  margin: var(--sp-4) 0 0;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}
</style>
