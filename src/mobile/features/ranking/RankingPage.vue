<script setup lang="ts">
/**
 * 排行榜列表。
 *
 * ## 分两个区：热门榜单 + 更多榜单
 *
 * `getRanks()`（`/rank/list`）一次给 57 个榜，平铺很难找。上游的做法是另调一个
 * `getRankTop()`（`/rank/top`）拿 6 个推荐榜，用它作为「热门」置于顶部。
 *
 * 这里比上游多做一步：从「更多榜单」里**排掉已经出现在热门区的**，
 * 以免同一个榜在屏幕上出现两次（两边并集仍覆盖全部 57 个，不会丢）。
 *
 * ## 榜单的曲目不在这个接口里
 *
 * `getRanks()` 返回的榜单**不含曲目**（`info[].list` 是空的），曲目要进详情页后
 * 再用 `getRankSongs(rankid)` 单独取 —— 这一点在首页磁贴跳转时就该知道，
 * 否则会误以为"榜单接口坏了"。
 *
 * ## ⚠️ 分组名（`group`）为什么是空的
 *
 * `/rank/list` 的分组信息在 `classify` 字段里（1/2/5…），而内核的 `mapRankMeta`
 * 读的是 `group` / `rank_type_name` / `type_info.name` —— 那是给扁平结构的
 * `/rank/top` 用的字段。上游也没做 `classify` → 名称的映射，所以不猜数字含义，
 * 改用「热门 / 更多」这种不需要映射表的划分。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { getRankTop, getRanks } from '@/api/playlist';
import { extractList } from '@/utils/extractors';
import { mapRankMeta } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { RankMeta } from '@/models/rank';

const router = useRouter();

type LoadState = 'loading' | 'ready' | 'error';

const state = ref<LoadState>('loading');
const failureReason = ref('');
/** 热门（`/rank/top` 的推荐位） */
const hotRanks = ref<RankMeta[]>([]);
/** 其余（`/rank/list` 里排掉热门的） */
const moreRanks = ref<RankMeta[]>([]);

const isEmpty = computed(() => !hotRanks.value.length && !moreRanks.value.length);

const load = async () => {
  state.value = 'loading';
  failureReason.value = '';
  try {
    // 两个接口并行：任一失败不拖累另一个，所以用 allSettled
    const [topResult, catalogResult] = await Promise.allSettled([getRankTop(), getRanks()]);
    if (topResult.status === 'rejected' && catalogResult.status === 'rejected') {
      throw topResult.reason ?? catalogResult.reason;
    }

    const mapAll = (result: PromiseSettledResult<unknown>) =>
      (result.status === 'fulfilled' ? extractList(result.value) : [])
        .map((item) => mapRankMeta(item))
        .filter((rank) => rank.id !== 0);

    const hot = mapAll(topResult);
    const catalog = mapAll(catalogResult);

    /**
     * 热门的详情常比全量里缺（推荐位给的字段少），用全量那条补全，
     * 免得热门区的副标题（更新频率）是空的 —— 上游也是这么拼的。
     */
    const catalogById = new Map(catalog.map((rank) => [rank.id, rank]));
    hotRanks.value = hot.map((rank) => {
      const detail = catalogById.get(rank.id);
      return {
        ...rank,
        updateFrequency: rank.updateFrequency || detail?.updateFrequency,
        description: rank.description || detail?.description,
        publishTime: detail?.publishTime || rank.publishTime,
      };
    });

    // 排掉已出现在热门区的，避免同一个榜在屏幕上出现两次（并集仍覆盖全部）
    const hotIds = new Set(hotRanks.value.map((rank) => rank.id));
    moreRanks.value = catalog.filter((rank) => !hotIds.has(rank.id));

    state.value = 'ready';
  } catch (error) {
    logger.warn('Ranking', 'Load ranks failed', error);
    failureReason.value = error instanceof Error ? error.message : String(error);
    state.value = 'error';
  }
};

const openRank = (rank: RankMeta) => {
  if (!rank.id) return;
  void router.push({ name: 'rank-detail', params: { id: String(rank.id) } });
};

/**
 * 副标题只用「更新频率」这类短字段。
 *
 * 不要回落 `description`：它是 `intro` 全文，实测有 50+ 字的
 * （「数据来源：全曲库歌曲，且喜爱用户数达到百万以上　排序方式：…更新频率：每天」），
 * 当副标题只会被截成一句没头没尾的话。
 */
const subtitleOf = (rank: RankMeta) => rank.updateFrequency || rank.rankTypeName || '';

onMounted(() => void load());
</script>

<template>
  <div class="ranking-page">
    <PageHeader title="排行榜" />

    <div class="page-body scroll-y">
      <EmptyState v-if="state === 'loading'" tone="loading" title="正在加载榜单" />
      <EmptyState
        v-else-if="state === 'error'"
        tone="error"
        title="榜单加载失败"
        :description="failureReason"
        action-label="重试"
        @action="load"
      />
      <EmptyState v-else-if="isEmpty" title="暂时没有榜单" />

      <template v-else>
        <section v-if="hotRanks.length" class="group">
          <h2 class="group-title">热门榜单</h2>
          <div class="grid">
            <MediaCard
              v-for="rank in hotRanks"
              :key="`hot-${rank.id}`"
              :cover="rank.pic"
              :title="rank.name"
              :subtitle="subtitleOf(rank)"
              @select="openRank(rank)"
            />
          </div>
        </section>

        <section v-if="moreRanks.length" class="group">
          <h2 class="group-title">更多榜单</h2>
          <div class="grid">
            <MediaCard
              v-for="rank in moreRanks"
              :key="rank.id"
              :cover="rank.pic"
              :title="rank.name"
              :subtitle="subtitleOf(rank)"
              @select="openRank(rank)"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ranking-page {
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
