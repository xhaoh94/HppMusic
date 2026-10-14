<script setup lang="ts">
/**
 * 探索。
 *
 * 原来是个占位页（只有一句「歌单分类即将上线」）。现在把注释里计划的那件事做了：
 * 按分类浏览歌单。
 *
 * ## 为什么是「两级分类」而不是一堆标签平铺
 *
 * 上游的标签接口返回的是**两级**结构：6 个父分类（场景 / 主题 / …），每个带一堆子标签
 * （光「场景」就有 23 个：学习、工作、通勤、运动…）。全平铺成一排会有上百个 chip，
 * 在手机上根本没法瞄；分两级之后第一层只有 6 个，第二层只在选中具体分类时才出现。
 *
 * 首页当初就是因为这个原因没做分类（它只要「推荐 / Hi-Res」两个档），
 * 分类浏览放在探索页正合适。
 *
 * ## 路由参数仍然要 global_collection_id
 *
 * 与首页同一套：数字 id 进歌单详情会拿到空曲目（`20010 get other list file fail`），
 * 所以 `routeIdOf` 优先取 `listCreateGid` / `globalCollectionId`。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { getPlaylistByCategory, getPlaylistTags } from '@/api/playlist';
import { extractList } from '@/utils/extractors';
import { mapPlaylistMeta } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { PlaylistMeta } from '@/models/playlist';

const router = useRouter();

interface TagChild {
  tagId: string;
  name: string;
}
interface TagGroup {
  tagId: string;
  name: string;
  children: TagChild[];
}

/** 「全部」不在接口返回里，自己补在最前面 */
const ALL_GROUP: TagGroup = { tagId: '0', name: '全部', children: [] };

const groups = ref<TagGroup[]>([ALL_GROUP]);
const activeGroupId = ref('0');
/** 实际发给接口的 `category_id`：可能是父分类本身，也可能是选中的子标签 */
const activeTagId = ref('0');

const playlists = ref<PlaylistMeta[]>([]);
const loading = ref(false);
const loadError = ref('');

/** 只用来丢弃过期响应：用户连点几个分类时，先发的可能后到 */
let generation = 0;

const activeGroup = computed(
  () => groups.value.find((group) => group.tagId === activeGroupId.value) ?? ALL_GROUP,
);
/** 选中「全部」时没有子标签，第二行整行不渲染 */
const children = computed(() => activeGroup.value.children ?? []);

const routeIdOf = (playlist: PlaylistMeta) =>
  String(
    playlist.listCreateGid ||
      playlist.globalCollectionId ||
      playlist.listCreateListid ||
      playlist.id ||
      '',
  );

const openPlaylist = (playlist: PlaylistMeta) => {
  const id = routeIdOf(playlist);
  if (!id) return;
  void router.push({ name: 'playlist', params: { id } });
};

const subtitleOf = (playlist: PlaylistMeta) => {
  const creator = playlist.nickname || '';
  const count = playlist.count ?? playlist.songcount ?? 0;
  if (creator && count) return `${creator} · ${count} 首`;
  return creator || (count ? `${count} 首` : '');
};

/**
 * 标签接口给的是 `{ tag_id, tag_name, son: [{ tag_id, tag_name }] }`。
 * 这里做一次归一化，页面里就只需要 `tagId` / `name` 这种稳定字段，
 * 不必到处写 `tag_id` 的取值回退。
 */
const normalizeGroups = (raw: unknown): TagGroup[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const tagId = String(record.tag_id ?? '').trim();
      const name = String(record.tag_name ?? '').trim();
      const children = Array.isArray(record.son)
        ? record.son
            .map((child) => {
              const node = (child ?? {}) as Record<string, unknown>;
              return {
                tagId: String(node.tag_id ?? '').trim(),
                name: String(node.tag_name ?? '').trim(),
              };
            })
            .filter((child) => child.tagId && child.name)
        : [];
      return { tagId, name, children };
    })
    .filter((group) => group.tagId && group.name);
};

const loadPlaylists = async () => {
  const token = ++generation;
  loading.value = true;
  loadError.value = '';
  try {
    // withsong=0：列表页只要封面与名字，带上歌曲会让响应大很多
    const response = await getPlaylistByCategory(activeTagId.value, 0, 1);
    if (token !== generation) return;
    playlists.value = extractList(response).map((item) => mapPlaylistMeta(item));
  } catch (error) {
    if (token !== generation) return;
    logger.warn('Explore', 'Load playlists failed', error);
    loadError.value = error instanceof Error ? error.message : '歌单加载失败';
  } finally {
    if (token === generation) loading.value = false;
  }
};

const selectGroup = (group: TagGroup) => {
  activeGroupId.value = group.tagId;
  /**
   * ⚠️ 只选中父分类是不够的：实测把父分类自己的 `tag_id` 发给接口返回**空列表**
   * （点「场景」后 0 张，而子标签「运动」能拿到 30 张）——上游只认子标签。
   * 所以选中分类时直接落到它的**第一个子标签**，用户马上能看到内容，
   * 不用再自己多点一次。
   */
  const first = group.children[0];
  activeTagId.value = first ? first.tagId : group.tagId;
  void loadPlaylists();
};

const selectChild = (child: TagChild) => {
  activeTagId.value = child.tagId;
  void loadPlaylists();
};

const load = async () => {
  try {
    const response = await getPlaylistTags();
    const normalized = normalizeGroups(extractList(response));
    // 接口没返回时保留「全部」，否则页面上一个 chip 都没有会让人以为坏了
    groups.value = [ALL_GROUP, ...normalized];
  } catch (error) {
    logger.warn('Explore', 'Load tags failed', error);
  }
  await loadPlaylists();
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="explore-page">
    <!-- 一级分类：7 个（接口 6 个父分类 + 全部），是**固定数量**，换行全显示 -->
    <div class="chips is-primary" role="tablist" aria-label="歌单分类">
      <button
        v-for="group in groups"
        :key="group.tagId"
        type="button"
        class="chip"
        role="tab"
        :aria-selected="activeGroupId === group.tagId"
        :class="{ 'is-active': activeGroupId === group.tagId }"
        @click="selectGroup(group)"
      >
        {{ group.name }}
      </button>
    </div>

    <!-- 二级标签：只在选中具体分类后出现 -->
    <div v-if="children.length" class="chips is-secondary scroll-x">
      <button
        v-for="child in children"
        :key="child.tagId"
        type="button"
        class="chip is-small"
        :class="{ 'is-active': activeTagId === child.tagId }"
        @click="selectChild(child)"
      >
        {{ child.name }}
      </button>
    </div>

    <div class="body scroll-y">
      <EmptyState v-if="loading && !playlists.length" tone="loading" title="正在加载歌单" />
      <EmptyState
        v-else-if="loadError && !playlists.length"
        title="歌单加载失败"
        :description="loadError"
      />
      <EmptyState
        v-else-if="!playlists.length"
        title="这个分类暂时没有歌单"
        description="换个分类或标签看看"
      />
      <div v-else class="grid">
        <MediaCard
          v-for="playlist in playlists"
          :key="`${playlist.id}-${playlist.name}`"
          :cover="playlist.pic"
          :title="playlist.name"
          :subtitle="subtitleOf(playlist)"
          @select="openPlaylist(playlist)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.explore-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.chips {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
}

/*
 * 一级分类：7 个固定数量，**换行**全部显示。
 *
 * 原来用横滑，但 7 个 chip（每个约 65px）超出窄屏约 90px —— 最后一个被切掉一半，
 * 看上去像坏了，而“能滑”这件事没有明显提示。数量固定且不多，换行是最直接的解法。
 */
.chips.is-primary {
  flex-wrap: wrap;
  row-gap: var(--sp-2);
  /* 一级行间距收窄，为“一行放下 7 个”多腾出一点宽度 */
  column-gap: var(--sp-2);
}

/*
 * 二级标签则保持横滑：「场景」下有 23 个子标签，换行会占掉大半屏高度。
 * 两级交互不一样是有意的：一级少而固定，二级多而可变。
 */
.chips.is-secondary {
  flex-wrap: nowrap;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  padding-top: 0;
  padding-left: var(--sp-6);
}

.chips.is-secondary::-webkit-scrollbar {
  display: none;
}

.chip {
  flex: 0 0 auto;
  min-height: 32px;
  /* 横向内边距收窄（原 --sp-4）：一级 7 个 chip 在 440px 宽屏上能刚好排成一行，
     而不是把「年代」单独挤到第二行。窄屏仍然会自动折行（父级是 flex-wrap）。 */
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.chip.is-small {
  min-height: 28px;
  padding: 0 var(--sp-3);
  font-size: var(--font-xs);
}

.chip.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: var(--weight-semibold);
}

.body {
  flex: 1;
  min-height: 0;
  padding: var(--sp-2) var(--sp-4) var(--sp-10);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4) var(--sp-3);
}
</style>
