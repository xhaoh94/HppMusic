<script setup lang="ts">
/**
 * 已购音乐。
 *
 * 单曲与专辑各自维护分页状态：首屏只请求两边的第 1 页，后续由各自哨兵按需加载，
 * 不把用户全部购买记录一次性拉进内存。接口解析和映射集中在 purchased adapter。
 */
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useRouter } from 'vue-router';
import SongRow from '@mobile/components/SongRow.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useCurrentSongKey } from '@mobile/composables/useCurrentSong';
import { songKeyOf } from '@mobile/utils/songKey';
import { usePlaybackActions } from '@mobile/adapters/player';
import { iconRefresh } from '@mobile/icons';
import {
  fetchPurchasedAlbumsPage,
  fetchPurchasedSongsPage,
  purchasedAlbumKey,
  purchasedSongKey,
  type PurchasedPage,
} from '@mobile/adapters/purchased';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
import logger from '@/utils/logger';
import type { AlbumMeta } from '@/models/album';
import type { Song } from '@/models/song';

defineOptions({ name: 'PurchasedPage' });

interface ListState<T> {
  items: Ref<T[]>;
  page: Ref<number>;
  hasMore: Ref<boolean>;
  total: Ref<number | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  lastPageEmpty: boolean;
  generation: number;
}

const makeListState = <T>(): ListState<T> => ({
  items: ref<T[]>([]) as Ref<T[]>,
  page: ref(0),
  hasMore: ref(true),
  total: ref(null),
  loading: ref(false),
  error: ref(''),
  lastPageEmpty: false,
  generation: 0,
});

const appendUnique = <T>(
  current: readonly T[], incoming: readonly T[], keyOf: (item: T) => string,
): T[] => {
  const seen = new Set(current.map(keyOf).filter(Boolean));
  const next = [...current];
  for (const item of incoming) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
};

const router = useRouter();
const user = useUserStore();
const { currentSongKey } = useCurrentSongKey();
const { playSong } = usePlaybackActions();

const songs = makeListState<Song>();
const albums = makeListState<AlbumMeta>();
const songSentinel = ref<HTMLElement | null>(null);
const albumSentinel = ref<HTMLElement | null>(null);

const resetList = <T>(state: ListState<T>) => {
  state.generation += 1;
  state.items.value = [];
  state.page.value = 0;
  state.total.value = null;
  state.hasMore.value = true;
  state.error.value = '';
  state.lastPageEmpty = false;
  // 让账号切换/退出登录时，旧请求的 finally 不能影响新状态。
  state.loading.value = false;
};

const loadList = async <T>(
  state: ListState<T>,
  loader: (page: number) => Promise<PurchasedPage<T>>,
  keyOf: (item: T) => string,
  options: { reset?: boolean; retry?: boolean } = {},
) => {
  if (state.loading.value) return;
  if (!options.reset && !options.retry && (!state.hasMore.value || state.error.value)) return;
  if (!user.isLoggedIn) return;

  if (options.reset) resetList(state);
  const generation = state.generation;
  const session = captureUserSession(user);
  const targetPage = options.reset ? 1 : state.page.value + 1;
  state.loading.value = true;
  state.error.value = '';

  try {
    const result = await loader(targetPage);
    if (generation !== state.generation || !session()) return;
    state.items.value = options.reset
      ? result.items
      : appendUnique(state.items.value, result.items, keyOf);
    state.page.value = targetPage;
    state.total.value = result.total;
    state.hasMore.value = result.hasMore;
    state.lastPageEmpty = result.items.length === 0;
  } catch (error) {
    if (generation !== state.generation || !session()) return;
    state.error.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === state.generation) state.loading.value = false;
  }
};

const loadSongs = (options: { reset?: boolean; retry?: boolean } = {}) =>
  loadList(songs, fetchPurchasedSongsPage, purchasedSongKey, options);
const loadAlbums = (options: { reset?: boolean; retry?: boolean } = {}) =>
  loadList(albums, fetchPurchasedAlbumsPage, purchasedAlbumKey, options);

onScopeDispose(() => {
  songs.generation += 1;
  albums.generation += 1;
});

const refreshForSession = () => {
  resetList(songs);
  resetList(albums);
  if (!user.isLoggedIn) return;
  void loadSongs({ reset: true });
  void loadAlbums({ reset: true });
};

const isRefreshing = computed(() => songs.loading.value || albums.loading.value);

/** 仅重新取第一页；分页大小仍由 adapter 固定为 30，不把购买记录全量拉回。 */
const refreshPurchased = () => {
  if (isRefreshing.value || !user.isLoggedIn) return;
  void loadSongs({ reset: true });
  void loadAlbums({ reset: true });
};

// accountRevision 同时覆盖登录、退出登录和切换账号，避免旧账号响应写入新账号页面。
watch([() => user.isLoggedIn, () => user.accountRevision], refreshForSession, { immediate: true });

watch(songSentinel, (element, _previous, onCleanup) => {
  if (!element || typeof IntersectionObserver === 'undefined') return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !songs.lastPageEmpty) {
        void loadSongs();
      }
    },
    { rootMargin: '240px' },
  );
  observer.observe(element);
  onCleanup(() => observer.disconnect());
});

watch(albumSentinel, (element, _previous, onCleanup) => {
  if (!element || typeof IntersectionObserver === 'undefined') return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !albums.lastPageEmpty) {
        void loadAlbums();
      }
    },
    { rootMargin: '240px' },
  );
  observer.observe(element);
  onCleanup(() => observer.disconnect());
});

const login = () => void router.push({ name: 'login' });

const onSelectSong = async (song: Song) => {
  try {
    await playSong(song, songs.items.value, {
      queueId: 'queue:purchased-songs',
      title: '已购单曲',
      subtitle: '',
    });
  } catch (error) {
    logger.warn('Purchased', 'Play purchased song failed', error);
  }
};

const openAlbum = (album: AlbumMeta) => {
  if (!album.id) return;
  void router.push({ name: 'album', params: { id: String(album.id) } });
};

const albumSubtitle = (album: AlbumMeta) => {
  const parts = [album.singerName, album.songCount > 0 ? `${album.songCount} 首` : ''].filter(Boolean);
  return parts.join(' · ');
};
</script>

<template>
  <div class="purchased-page">
    <!-- 刷新并入第一个分区标题行：单开一行只有个图标太浪费纵向空间 -->
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
          <span v-if="songs.total.value !== null" class="section-count">{{ songs.total.value }} 首</span>
          <button
            type="button"
            class="header-refresh"
            :disabled="isRefreshing"
            aria-label="刷新已购音乐"
            @click="refreshPurchased"
          >
            <Icon :icon="iconRefresh" width="18" height="18" :class="{ spin: isRefreshing }" />
          </button>
        </div>

        <EmptyState
          v-if="songs.loading.value && !songs.items.value.length"
          tone="loading"
          title="正在加载已购单曲"
        />
        <EmptyState
          v-else-if="songs.error.value && !songs.items.value.length"
          tone="error"
          title="已购单曲加载失败"
          :description="songs.error.value"
          action-label="重试"
          @action="loadSongs({ retry: true })"
        />
        <p v-else-if="!songs.items.value.length" class="section-empty">还没有已购单曲</p>

        <template v-else>
          <div class="song-list">
            <SongRow
              v-for="song in songs.items.value"
              :key="purchasedSongKey(song)"
              :song="song"
              :active="songKeyOf(song) === currentSongKey"
              @select="onSelectSong"
            />
          </div>
        </template>
        <div
          v-if="songs.items.value.length || (!songs.loading.value && !songs.error.value && songs.hasMore.value)"
          ref="songSentinel"
          class="list-footer"
        >
          <template v-if="songs.loading.value">正在加载更多…</template>
          <button v-else-if="songs.error.value" type="button" class="retry" @click="loadSongs({ retry: true })">
            加载失败，点击重试
          </button>
          <template v-else-if="!songs.hasMore.value">没有更多了</template>
          <button v-else type="button" class="retry" @click="loadSongs()">加载更多</button>
        </div>
      </section>

      <section class="purchased-section">
        <div class="section-heading">
          <h2>已购专辑</h2>
          <span v-if="albums.total.value !== null" class="section-count">{{ albums.total.value }} 张</span>
        </div>

        <EmptyState
          v-if="albums.loading.value && !albums.items.value.length"
          tone="loading"
          title="正在加载已购专辑"
        />
        <EmptyState
          v-else-if="albums.error.value && !albums.items.value.length"
          tone="error"
          title="已购专辑加载失败"
          :description="albums.error.value"
          action-label="重试"
          @action="loadAlbums({ retry: true })"
        />
        <p v-else-if="!albums.items.value.length" class="section-empty">还没有已购专辑</p>

        <template v-else>
          <div class="album-grid">
            <MediaCard
              v-for="album in albums.items.value"
              :key="purchasedAlbumKey(album)"
              :cover="album.pic"
              :title="album.name || '未知专辑'"
              :subtitle="albumSubtitle(album)"
              :badge="album.songCount > 0 ? `${album.songCount} 首` : ''"
              @select="openAlbum(album)"
            />
          </div>
        </template>
        <div
          v-if="albums.items.value.length || (!albums.loading.value && !albums.error.value && albums.hasMore.value)"
          ref="albumSentinel"
          class="list-footer"
        >
          <template v-if="albums.loading.value">正在加载更多…</template>
          <button v-else-if="albums.error.value" type="button" class="retry" @click="loadAlbums({ retry: true })">
            加载失败，点击重试
          </button>
          <template v-else-if="!albums.hasMore.value">没有更多了</template>
          <button v-else type="button" class="retry" @click="loadAlbums()">加载更多</button>
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

.header-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 标题行内的小图标按钮：30px 刚好不把行高撑起来 */
  margin-left: auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--text-primary);
}

.header-refresh:disabled {
  opacity: 0.55;
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
