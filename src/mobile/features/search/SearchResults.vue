<script setup lang="ts">
/**
 * 搜索结果（多标签）。
 *
 * 每个标签一条独立的无限滚动列表，切换标签即重新加载该类型的第一页。
 * 不做标签结果的本地缓存：搜索场景下用户真正重复点同一个标签的概率很低，
 * 而缓存要处理"关键词变了但缓存没变"的失效问题 —— 收益不抵复杂度。
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import SongRow from '@mobile/components/SongRow.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { usePlaybackActions } from '@mobile/adapters/player';
import {
  SEARCH_TABS,
  searchByType,
  type SearchTabType,
  type SearchItemView,
} from '@mobile/adapters/search';
import type { Song } from '@/models/song';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';

const props = defineProps<{ keywords: string }>();

const router = useRouter();
const { playSong } = usePlaybackActions();

const activeTab = ref<SearchTabType>('song');
const activeTabMeta = computed(
  () => SEARCH_TABS.find((tab) => tab.type === activeTab.value) ?? SEARCH_TABS[0],
);

const list = useInfiniteList<SearchItemView>(
  // loader 在调用时读 activeTab，所以标签切换只要 reload() 即可
  (page) => searchByType(props.keywords, activeTab.value, page),
);

watch(activeTab, () => void list.reload());
watch(
  () => props.keywords,
  () => void list.reload(),
);

/** 单曲标签下的全部已加载歌曲 —— 作为播放上下文，点一首能连播 */
const loadedSongs = computed(() =>
  list.items.value
    .map((entry) => entry.item)
    .filter((item): item is { kind: 'song'; song: Song } => item.kind === 'song')
    .map((item) => item.song),
);

const onSelectSong = async (song: Song) => {
  await playSong(song, loadedSongs.value, {
    queueId: `queue:search:${props.keywords}`,
    title: `搜索「${props.keywords}」`,
    subtitle: '',
  });
};

const openPlaylist = (id: string) => void router.push({ name: 'playlist', params: { id } });
const openAlbum = (id: string) => void router.push({ name: 'album', params: { id } });
const openArtist = (id: string) => void router.push({ name: 'artist', params: { id } });

/** 卡片类标签（歌单/专辑/歌手）用栅格，单曲类用列表 */
const isCardTab = computed(() => activeTab.value !== 'song' && activeTab.value !== 'lyric');

/** 把条目转成卡片需要的字段，模板里就不必写一长串三元 */
const cardView = (item: SearchItemView['item']) => {
  if (item.kind === 'playlist') {
    return {
      cover: item.playlist.pic,
      title: item.playlist.name,
      subtitle: item.playlist.nickname || '',
      round: false,
      onSelect: () => openPlaylist(item.routeId),
    };
  }
  if (item.kind === 'album') {
    return {
      cover: item.album.pic,
      title: item.album.name,
      subtitle: item.album.singerName || '',
      round: false,
      onSelect: () => openAlbum(item.id),
    };
  }
  if (item.kind === 'artist') {
    return {
      cover: item.artist.pic,
      title: item.artist.name,
      subtitle: item.artist.songCount ? `${item.artist.songCount} 首歌` : '',
      round: true,
      onSelect: () => openArtist(item.id),
    };
  }
  return { cover: '', title: '', subtitle: '', round: false, onSelect: () => {} };
};
/** 给「定位到当前播放」用：只有单曲/歌词 tab 是歌曲行，其余是两列栅格 */
const locateSongs = computed(() =>
  isCardTab.value
    ? []
    : (list.items.value as { item: { song?: Song } }[])
        .map((entry) => entry.item?.song)
        .filter((song): song is Song => Boolean(song)),
);
</script>

<template>
  <div class="search-results">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="locateSongs" />
    <nav class="tabs scroll-x" aria-label="搜索结果分类">
      <button
        v-for="tab in SEARCH_TABS"
        :key="tab.type"
        type="button"
        class="tab"
        :class="{ 'is-active': tab.type === activeTab }"
        :aria-current="tab.type === activeTab ? 'true' : undefined"
        @click="activeTab = tab.type"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="results-body scroll-y">
      <EmptyState v-if="list.isLoading.value" tone="loading" title="正在搜索" />
      <EmptyState
        v-else-if="list.error.value"
        tone="error"
        title="搜索失败"
        :description="list.error.value"
        action-label="重试"
        @action="list.reload()"
      />
      <EmptyState
        v-else-if="list.isEmpty.value"
        :title="activeTabMeta.emptyHint"
        description="换个关键词试试，或者看看热搜"
      />

      <template v-else>
        <!-- 单曲 / 歌词：列表 -->
        <template v-if="!isCardTab">
          <SongRow
            v-for="entry in list.items.value"
            :key="entry.key"
            :song="(entry.item as { kind: 'song'; song: Song }).song"
            @select="onSelectSong"
          />
        </template>

        <!-- 歌单 / 专辑 / 歌手：两列栅格 -->
        <div v-else class="grid">
          <MediaCard
            v-for="entry in list.items.value"
            :key="entry.key"
            :cover="cardView(entry.item).cover"
            :title="cardView(entry.item).title"
            :subtitle="cardView(entry.item).subtitle"
            :round="cardView(entry.item).round"
            @select="cardView(entry.item).onSelect()"
          />
        </div>
      </template>

      <!-- 哨兵：进入视口即加载下一页。加载态与错误态都由 list 自己判断， -->
      <!-- 避免"到底了还在转圈" -->
      <div
        v-if="list.items.value.length > 0"
        :ref="list.sentinel"
        class="sentinel"
      >
        <template v-if="list.isLoadingMore.value">正在加载更多…</template>
        <template v-else-if="list.error.value">
          <button type="button" class="retry" @click="list.retry()">加载失败，点击重试</button>
        </template>
        <template v-else-if="!list.hasMore.value">没有更多了</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-results {
  /* 定位按钮的绝对定位参照 */
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-3) var(--sp-2);
}

.tab {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  color: var(--text-secondary);
  background: transparent;
}

.tab.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: var(--weight-semibold);
}

.results-body {
  flex: 1;
  min-height: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4) var(--sp-3);
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
}

.sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: var(--sp-3);
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
