<script setup lang="ts">
/**
 * 已购音乐。
 *
 * 单曲与专辑各自一页分页列表，统一走 `useInfiniteList`（项目里其它列表页也用同一个
 * composable）。这里**不再自己实现一套分页状态**：之前那套手写逻辑已经与
 * `useInfiniteList` 行为分叉（少了 isEmpty/total 语义、多了 lastPageEmpty 特判），
 * 于是同一个 App 里“到底了怎么提示”“失败怎么重试”在不同页面表现不一致。
 *
 * 分页大小固定 30，首屏只拉第 1 页，后续由哨兵按需加载，不把用户全部购买记录
 * 一次性读进内存。响应解析与去重集中在 `@mobile/adapters/purchased`。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import SongRow from '@mobile/components/SongRow.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { Icon } from '@iconify/vue';
import { iconRefresh } from '@mobile/icons';
import { useCurrentSongKey } from '@mobile/composables/useCurrentSong';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { songKeyOf } from '@mobile/utils/songKey';
import { usePlaybackActions } from '@mobile/adapters/player';
import {
  fetchPurchasedAlbumsPage,
  fetchPurchasedSongsPage,
  purchasedAlbumKey,
  purchasedSongKey,
} from '@mobile/adapters/purchased';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { watchUserSession } from '@/utils/watchUserSession';
import logger from '@/utils/logger';
import type { AlbumMeta } from '@/models/album';
import type { Song } from '@/models/song';

defineOptions({ name: 'PurchasedPage' });

const router = useRouter();
const user = useUserStore();
const toast = useToastStore();
const { currentSongKey } = useCurrentSongKey();
const { playSong } = usePlaybackActions();

/**
 * 分页装载器：在**页内与跨页**去重后再交给 `useInfiniteList` 追加。
 *
 * `useInfiniteList` 只做“追加”，不认业务主键（重复条目会直接进列表）；
 * 已购接口在不同页之间会返回重复记录，所以去重放在这一层。
 * 第 1 页清空已见集合，重新加载（刷新/换账号）时不会残留旧键。
 *
 * ⚠️ `row:` 键（无任何元数据）跨页不可比，但也**不能丢条目**——保留更安全。
 */
const createLoader = <T,>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean; total: number | null }>,
  keyOf: (item: T, index: number) => string,
) => {
  const seen = new Set<string>();
  return async (page: number) => {
    if (page === 1) seen.clear();
    const result = await fetchPage(page);
    const items: T[] = [];
    for (const [index, item] of result.items.entries()) {
      const key = keyOf(item, index);
      const comparable = !key.startsWith('row:');
      if (comparable) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push(item);
    }
    return { items, hasMore: result.hasMore, total: result.total };
  };
};

const {
  items: songs,
  total: songsTotal,
  hasMore: songsHasMore,
  isLoading: songsLoading,
  isLoadingMore: songsLoadingMore,
  isEmpty: songsEmpty,
  error: songsError,
  sentinel: songSentinel,
  reload: reloadSongs,
  loadMore: loadMoreSongs,
  retry: retrySongs,
} = useInfiniteList(createLoader(fetchPurchasedSongsPage, purchasedSongKey), { immediate: false });

const {
  items: albums,
  total: albumsTotal,
  hasMore: albumsHasMore,
  isLoading: albumsLoading,
  isLoadingMore: albumsLoadingMore,
  isEmpty: albumsEmpty,
  error: albumsError,
  sentinel: albumSentinel,
  reload: reloadAlbums,
  loadMore: loadMoreAlbums,
  retry: retryAlbums,
} = useInfiniteList(createLoader(fetchPurchasedAlbumsPage, purchasedAlbumKey), { immediate: false });

const refreshing = computed(() => songsLoading.value || albumsLoading.value);

/**
 * 会话变化 + 首次进入都走这里。
 *
 * 用 `watchUserSession` 而不是只看 isLoggedIn/accountRevision：在途请求是用
 * `captureUserSession`（4 个字段）校验的，watcher 少监 token 时，token 变化
 * （续期/免登恢复）会让响应被丢弃而页面停在空态、也没有任何提示。
 */
watchUserSession(
  user,
  () => {
    if (!user.isLoggedIn) return;
    void reloadSongs();
    void reloadAlbums();
  },
  { immediate: true },
);

/** 手动刷新：只重拉第 1 页，不做常驻轮询。 */
const refresh = () => {
  if (!user.isLoggedIn || refreshing.value) return;
  void reloadSongs();
  void reloadAlbums();
};

const login = () => void router.push({ name: 'login' });

const onSelectSong = async (song: Song) => {
  try {
    await playSong(song, songs.value, {
      queueId: 'queue:purchased-songs',
      title: '已购单曲',
      subtitle: '',
    });
  } catch (error) {
    logger.warn('Purchased', 'Play purchased song failed', error);
  }
};

const openAlbum = (album: AlbumMeta) => {
  const id = String(album.id || album.albumid || album.album_id || '').trim();
  if (!id || id === '0') {
    // 上游没给 id 时不能静默 return：用户只会觉得“点了没反应”。
    toast.info('这张专辑信息不完整，暂时无法打开');
    return;
  }
  void router.push({ name: 'album', params: { id } });
};

/** 只拼歌手：首数已由卡片角标（badge）展示，两处都写会看到两个“N 首”。 */
const albumSubtitle = (album: AlbumMeta) => album.singerName || '';

const songCountLabel = (total: number | null) => (total !== null ? `${total} 首` : '');
const albumCountLabel = (total: number | null) => (total !== null ? `${total} 张` : '');
</script>

<template>
  <div class="purchased-page">
    <!--
      不放 PageHeader：页面在「主页」分区下，顶部子页签栏已经表明当前位置，
      再顶一行「‹ 已购音乐」是重复信息（与随便听/一起听/私人 FM 同一处理）。
      原本在那里的刷新按钮移到「已购单曲」标题行右侧。
    -->
    <div v-if="!user.isLoggedIn" class="page-body scroll-y">
      <EmptyState
        title="登录后查看已购音乐"
        description="已购单曲和专辑会随账号同步"
        action-label="去登录"
        @action="login"
      />
    </div>

    <div v-else class="page-body scroll-y">
      <section class="purchased-section">
        <div class="section-heading">
          <h2>已购单曲</h2>
          <span v-if="songCountLabel(songsTotal)" class="section-count">
            {{ songCountLabel(songsTotal) }}
          </span>
          <button
            type="button"
            class="section-refresh"
            :disabled="refreshing"
            aria-label="刷新已购音乐"
            @click="refresh"
          >
            <Icon :icon="iconRefresh" width="17" height="17" :class="{ spin: refreshing }" />
          </button>
        </div>

        <EmptyState
          v-if="songsLoading && !songs.length"
          tone="loading"
          title="正在加载已购单曲"
        />
        <EmptyState
          v-else-if="songsError && !songs.length"
          tone="error"
          title="已购单曲加载失败"
          :description="songsError"
          action-label="重试"
          @action="retrySongs"
        />
        <p v-else-if="songsEmpty" class="section-empty">还没有已购单曲</p>

        <div v-if="songs.length" class="song-list">
          <SongRow
            v-for="(song, index) in songs"
            :key="purchasedSongKey(song, index)"
            :song="song"
            :active="songKeyOf(song) === currentSongKey"
            @select="onSelectSong"
          />
        </div>

        <!-- 空页但服务端说还有更多：给一个手动继续的入口，避免自动续页死循环 -->
        <div v-if="songsEmpty && songsHasMore" class="list-footer">
          <button type="button" class="retry" @click="loadMoreSongs">加载更多</button>
        </div>
        <div v-else-if="songs.length" ref="songSentinel" class="list-footer">
          <template v-if="songsLoadingMore">正在加载更多…</template>
          <button v-else-if="songsError" type="button" class="retry" @click="retrySongs">
            加载失败，点击重试
          </button>
          <template v-else-if="!songsHasMore">没有更多了</template>
          <button v-else type="button" class="retry" @click="loadMoreSongs">加载更多</button>
        </div>
      </section>

      <section class="purchased-section">
        <div class="section-heading">
          <h2>已购专辑</h2>
          <span v-if="albumCountLabel(albumsTotal)" class="section-count">
            {{ albumCountLabel(albumsTotal) }}
          </span>
        </div>

        <EmptyState
          v-if="albumsLoading && !albums.length"
          tone="loading"
          title="正在加载已购专辑"
        />
        <EmptyState
          v-else-if="albumsError && !albums.length"
          tone="error"
          title="已购专辑加载失败"
          :description="albumsError"
          action-label="重试"
          @action="retryAlbums"
        />
        <p v-else-if="albumsEmpty" class="section-empty">还没有已购专辑</p>

        <div v-if="albums.length" class="album-grid">
          <MediaCard
            v-for="(album, index) in albums"
            :key="purchasedAlbumKey(album, index)"
            :cover="album.pic"
            :title="album.name || '未知专辑'"
            :subtitle="albumSubtitle(album)"
            :badge="album.songCount > 0 ? `${album.songCount} 首` : ''"
            @select="openAlbum(album)"
          />
        </div>

        <div v-if="albumsEmpty && albumsHasMore" class="list-footer">
          <button type="button" class="retry" @click="loadMoreAlbums">加载更多</button>
        </div>
        <div v-else-if="albums.length" ref="albumSentinel" class="list-footer">
          <template v-if="albumsLoadingMore">正在加载更多…</template>
          <button v-else-if="albumsError" type="button" class="retry" @click="retryAlbums">
            加载失败，点击重试
          </button>
          <template v-else-if="!albumsHasMore">没有更多了</template>
          <button v-else type="button" class="retry" @click="loadMoreAlbums">加载更多</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.purchased-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.purchased-section {
  padding: var(--sp-3) 0 var(--sp-2);
}

.section-heading {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-4) var(--sp-2);
}

.section-heading h2 {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.section-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.song-list {
  display: flex;
  flex-direction: column;
}

.album-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-4) var(--sp-3);
  padding: 0 var(--sp-4);
}

.section-empty {
  margin: 0;
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.section-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 标题行里的小图标按钮：向下收一点，不把行高撑起来 */
  margin-left: auto;
  width: 30px;
  height: 30px;
  margin-block: -4px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.section-refresh:disabled {
  opacity: 0.55;
}

.spin {
  animation: purchased-spin 900ms linear infinite;
}

@keyframes purchased-spin {
  to {
    transform: rotate(360deg);
  }
}

.list-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  padding: 0 var(--sp-4);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.retry {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  color: var(--accent);
  background: var(--accent-soft);
  font-size: var(--font-sm);
}
</style>
