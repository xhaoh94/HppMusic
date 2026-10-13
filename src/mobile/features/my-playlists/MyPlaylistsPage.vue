<script setup lang="ts">
/**
 * 我的歌单（自建 + 收藏的歌单）。
 *
 * 数据来自内核 `playlistStore.userPlaylists`（`fetchUserPlaylists` 从服务端拉），
 * 需要登录。分两类展示：「我创建的」与「我收藏的」——
 * 上游的 `getCreatedPlaylists(currentUserId)` 负责前者，
 * 两者混在一起排会让人分不清哪个是自己建的。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import type { PlaylistMeta } from '@/models/playlist';

const router = useRouter();
const playlist = usePlaylistStore();
const user = useUserStore();

const loadError = ref('');
const loaded = ref(false);

const all = computed<PlaylistMeta[]>(() => playlist.userPlaylists ?? []);

const created = computed(() => {
  const userId = user.info?.userid;
  if (!userId) return [];
  try {
    return playlist.getCreatedPlaylists(userId);
  } catch {
    return [];
  }
});

const collected = computed(() => {
  const createdIds = new Set(created.value.map((item) => String(item.id)));
  return all.value.filter((item) => !createdIds.has(String(item.id)));
});

const load = async (force = false) => {
  loadError.value = '';
  try {
    await playlist.fetchUserPlaylists();
    loaded.value = true;
  } catch (error) {
    logger.warn('MyPlaylists', 'Load user playlists failed', error);
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    // force 只是为了让「重试」能重新触发，实际拉取由 store 自己控制缓存
    void force;
  }
};

/** 路由参数要 global_collection_id（数字 id 拿不到曲目），mapPlaylistMeta 已回退好 */
const open = (item: PlaylistMeta) => {
  const id = item.globalCollectionId || String(item.id ?? '');
  if (!id) return;
  void router.push({ name: 'playlist', params: { id } });
};

const subtitleOf = (item: PlaylistMeta) => {
  const count = item.count ?? item.songcount ?? 0;
  const owner = item.nickname || '';
  return owner ? `${count} 首 · ${owner}` : `${count} 首`;
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="my-playlists-page">
    <PageHeader title="我的歌单" />

    <div class="page-body scroll-y">
      <EmptyState v-if="!loaded && !loadError" tone="loading" title="正在加载歌单" />
      <EmptyState
        v-else-if="loadError"
        tone="error"
        title="歌单加载失败"
        :description="loadError"
        action-label="重试"
        @action="load(true)"
      />
      <EmptyState
        v-else-if="!all.length"
        title="还没有歌单"
        description="在酷狗客户端创建的歌单会同步到这里"
      />

      <template v-else>
        <section v-if="created.length" class="group">
          <h2 class="group-title">我创建的</h2>
          <div class="grid">
            <MediaCard
              v-for="item in created"
              :key="`created-${item.id}`"
              :cover="item.pic"
              :title="item.name"
              :subtitle="subtitleOf(item)"
              @select="open(item)"
            />
          </div>
        </section>

        <section v-if="collected.length" class="group">
          <h2 class="group-title">我收藏的</h2>
          <div class="grid">
            <MediaCard
              v-for="item in collected"
              :key="`collected-${item.id}`"
              :cover="item.pic"
              :title="item.name"
              :subtitle="subtitleOf(item)"
              @select="open(item)"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.my-playlists-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.group {
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
}

.group-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4) var(--sp-3);
}
</style>
