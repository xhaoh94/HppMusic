<script setup lang="ts">
/**
 * 发现（首页）。
 *
 * 结构对齐参考产品的一屏：
 *
 * ```
 * Hi, {昵称} 一起听歌吧        ← 问候语（未登录时只说"一起听歌吧"）
 * 由此开启好心情 ~
 *
 * [14 每日推荐] [TOP 排行榜] [🎤 听歌识曲] [🔍 搜索]   ← 4 个竖排磁贴
 *
 * 推荐歌单                    [推荐] [Hi-Res]   ← 标题 + 来源切换
 * [卡片] [卡片]
 *
 * 编辑精选
 * [卡片] [卡片]
 * ```
 *
 * ## 三处与桌面端不同的取舍
 *
 * 1. **磁贴是竖排的**（图标块在上、文字在下），不是桌面那种横排大卡片 ——
 *    四张横排卡在 360px 屏上每个只有 80px 宽，副标题必然被压成竖排。
 * 2. **每日推荐列表不在首页**，磁贴跳到独立页：参考产品首屏是"磁贴 + 歌单网格"，
 *    把 30 首歌曲列表塞进来会让首屏长到看不到歌单。
 * 3. **不做「风格推荐」**：参考产品的首屏没有这一块（旧项目桌面端有），
 *    而且它带二级分类 + tag 多选，在手机上要再多两层交互才用得上。
 *
 * ## 数据来源
 * · 推荐歌单：`getPlaylistByCategory(categoryId)`，分类 `0=推荐`、`11292=Hi-Res`
 * · 编辑精选：`getTopIP()`，需过滤出 `type === 1` 且带 global id 的条目
 *   （不滤的话会混进 IP 头像位等非歌单内容，点进去是空的）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import type { IconifyIcon } from '@iconify/types';
import MediaCard from '@mobile/components/MediaCard.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { iconMicrophone, iconSearch, iconSparkles } from '@mobile/icons';
import { useUserStore } from '@/stores/user';
import { usePlayerStore } from '@/stores/player';
import { getPlaylistByCategory, getTopIP } from '@/api/playlist';
import { extractList } from '@/utils/extractors';
import { mapPlaylistMeta } from '@/utils/mappers';
import logger from '@/utils/logger';
import type { PlaylistMeta } from '@/models/playlist';

/** 组件名：App.vue 的 KeepAlive `:include` 按这个名字匹配（对不上是静默失效，不会报错） */
defineOptions({ name: 'HomePage' });

const router = useRouter();
const user = useUserStore();
const player = usePlayerStore();

/* ── 问候语 ── */
const greeting = computed(() => {
  const nickname = user.info?.nickname;
  return user.isLoggedIn && nickname ? `Hi, ${nickname} 一起听歌吧` : '一起听歌吧';
});
/** 每日推荐磁贴上的日期数字（与参考产品一致：显示"今天几号"） */
const todayLabel = computed(() => String(new Date().getDate()));

/* ── 磁贴 ── */
interface Tile {
  key: string;
  label: string;
  /** 图标块里的内容：文字（14/TOP）或图标 */
  text?: string;
  icon?: IconifyIcon;
  tone: 'green' | 'dark' | 'purple' | 'blue';
  available: boolean;
  hint?: string;
}

const tiles = computed<Tile[]>(() => [
  { key: 'daily', label: '每日推荐', text: todayLabel.value, tone: 'green', available: true },
  { key: 'ranking', label: '排行榜', text: 'TOP', tone: 'dark', available: true },
  { key: 'recognize', label: '听歌识曲', icon: iconMicrophone, tone: 'purple', available: true },
  { key: 'search', label: '搜索', icon: iconSearch, tone: 'blue', available: true },
]);

const onTile = (tile: Tile) => {
  if (!tile.available) return;
  if (tile.key === 'daily') void router.push({ name: 'recommend' });
  else if (tile.key === 'ranking') void router.push({ name: 'ranking' });
  else if (tile.key === 'recognize') void router.push({ name: 'recognize' });
  else if (tile.key === 'search') void router.push({ name: 'search' });
};

/* ── 推荐歌单 ── */
const PLAYLIST_CATEGORIES = [
  { id: '0', label: '推荐' },
  { id: '11292', label: 'Hi-Res' },
] as const;

const activeCategoryId = ref<string>(PLAYLIST_CATEGORIES[0].id);
const recommended = ref<PlaylistMeta[]>([]);
const recommendState = ref<'loading' | 'ready' | 'error'>('loading');
const recommendError = ref('');

/** 本地正在播放的曲目在哪个歌单里 —— 用于给卡片打"当前播放"标记 */
const activeQueueId = computed(() => String(player.currentSourceQueueId ?? ''));

const loadRecommended = async () => {
  const categoryId = activeCategoryId.value;
  recommendState.value = 'loading';
  recommendError.value = '';
  try {
    const response = await getPlaylistByCategory(categoryId, 0, 1);
    // 期间用户切了分类就丢弃这次结果
    if (categoryId !== activeCategoryId.value) return;
    recommended.value = extractList(response).map((item) => mapPlaylistMeta(item));
    recommendState.value = 'ready';
  } catch (error) {
    if (categoryId !== activeCategoryId.value) return;
    logger.warn('Home', 'Load recommended playlists failed', error);
    recommendError.value = error instanceof Error ? error.message : String(error);
    recommendState.value = 'error';
  }
};

/* ── 编辑精选 ── */
const topIp = ref<PlaylistMeta[]>([]);
const topIpState = ref<'loading' | 'ready' | 'error'>('loading');
const topIpError = ref('');

const loadTopIp = async () => {
  topIpState.value = 'loading';
  topIpError.value = '';
  try {
    const response = await getTopIP();
    topIp.value = extractList(response)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      // 只留真正的歌单：其它 type 是 IP 头像位之类的展示位，点进去没有曲目
      .filter((item) => {
        const extra = item.extra as Record<string, unknown> | undefined;
        const globalId = extra?.global_collection_id ?? extra?.global_special_id;
        return Number(item.type) === 1 && Boolean(globalId);
      })
      .map((item) => mapPlaylistMeta(item));
    topIpState.value = 'ready';
  } catch (error) {
    logger.warn('Home', 'Load top ip failed', error);
    topIpError.value = error instanceof Error ? error.message : String(error);
    topIpState.value = 'error';
  }
};

/**
 * 歌单卡片 → 路由 id。
 *
 * 用 `global_collection_id`（内核的 `getPlaylistDetail` / `getPlaylistTracks` 要的就是它），
 * 数字 listid 那条件只在拿不到 global id 时兜底。顺序沿用上游：
 * `listCreateGid || globalCollectionId || listCreateListid || id`。
 */
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

const switchCategory = (id: string) => {
  if (activeCategoryId.value === id) return;
  activeCategoryId.value = id;
  void loadRecommended();
};

onMounted(() => {
  if (user.isLoggedIn) void user.fetchUserInfoOnce();
  void loadRecommended();
  void loadTopIp();
});

// 「Hi-Res」分类的结果和「推荐」差别很大，切回来时重新拉一次更稳
watch(activeCategoryId, () => void loadRecommended());
</script>

<template>
  <div class="home-page scroll-y">
    <!-- 问候语 -->
    <header class="greeting">
      <h1 class="greeting-title">{{ greeting }}</h1>
      <p class="greeting-sub">由此开启好心情～</p>
    </header>

    <!-- 功能磁贴：竖排（图标块在上、文字在下） -->
    <nav class="tiles" aria-label="快捷入口">
      <button
        v-for="tile in tiles"
        :key="tile.key"
        type="button"
        class="tile"
        :class="{ 'is-muted': !tile.available }"
        :aria-label="tile.hint ? `${tile.label}（${tile.hint}）` : tile.label"
        @click="onTile(tile)"
      >
        <span class="tile-icon" :class="`tone-${tile.tone}`">
          <span v-if="tile.text" class="tile-icon-text">{{ tile.text }}</span>
          <Icon v-else-if="tile.icon" :icon="tile.icon" width="22" height="22" />
        </span>
        <span class="tile-label">{{ tile.label }}</span>
      </button>
    </nav>

    <!-- 推荐歌单 -->
    <section class="section">
      <header class="section-header">
        <h2 class="section-title">推荐歌单</h2>
        <div class="source-tabs" role="tablist" aria-label="推荐歌单分类">
          <button
            v-for="category in PLAYLIST_CATEGORIES"
            :key="category.id"
            type="button"
            class="source-tab"
            :class="{ 'is-active': activeCategoryId === category.id }"
            role="tab"
            :aria-selected="activeCategoryId === category.id"
            @click="switchCategory(category.id)"
          >
            {{ category.label }}
          </button>
        </div>
      </header>

      <EmptyState v-if="recommendState === 'loading'" tone="loading" title="正在加载歌单" />
      <EmptyState
        v-else-if="recommendState === 'error'"
        tone="error"
        title="推荐歌单加载失败"
        :description="recommendError"
        action-label="重试"
        @action="loadRecommended"
      />
      <EmptyState
        v-else-if="!recommended.length"
        title="暂时没有推荐歌单"
        description="稍后再试试"
      />
      <div v-else class="scroll-row scroll-x">
        <MediaCard
          v-for="playlist in recommended"
          :key="`rec-${playlist.id}`"
          :cover="playlist.pic"
          :title="playlist.name"
          :subtitle="subtitleOf(playlist)"
          @select="openPlaylist(playlist)"
        />
      </div>
    </section>

    <!-- 编辑精选 -->
    <section class="section">
      <header class="section-header">
        <h2 class="section-title">编辑精选</h2>
      </header>

      <EmptyState v-if="topIpState === 'loading'" tone="loading" title="正在加载精选" />
      <EmptyState
        v-else-if="topIpState === 'error'"
        tone="error"
        title="编辑精选加载失败"
        :description="topIpError"
        action-label="重试"
        @action="loadTopIp"
      />
      <div v-else class="scroll-row scroll-x">
        <MediaCard
          v-for="playlist in topIp"
          :key="`ip-${playlist.id}`"
          :cover="playlist.pic"
          :title="playlist.name"
          :subtitle="subtitleOf(playlist)"
          @select="openPlaylist(playlist)"
        />
      </div>
    </section>

    <p class="footer-note">内容来自酷狗音乐，版权归原平台及版权方所有</p>
  </div>
</template>

<style scoped>
.home-page {
  height: 100%;
  padding-bottom: var(--sp-6);
}

/* ── 问候语 ── */
.greeting {
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}

.greeting-title {
  margin: 0 0 var(--sp-1);
  font-size: var(--font-2xl);
  font-weight: var(--weight-bold);
  letter-spacing: -0.01em;
}

.greeting-sub {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

/* ── 磁贴 ── */
.tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-5);
}

/*
 * 磁贴是一块**独立卡片**（对齐参考产品）：原来只有"彩色图标块 + 底下裸文字"，
 * 在深色背景上显得散、也没有可点的边界感。包成卡片后整块都是热区，点击意图更清楚。
 */
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-1);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
  transition: background var(--duration-fast) var(--ease-standard);
}

.tile:active {
  background: var(--fill-muted);
}

.tile:active .tile-icon {
  transform: scale(0.94);
}

.tile.is-muted {
  opacity: 0.55;
}

/* 图标块：卡片内缩小一号（56 → 44），留出卡片的呼吸感 */
.tile-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  color: #fff;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.tile-icon-text {
  font-size: var(--font-lg);
  font-weight: var(--weight-bold);
  letter-spacing: -0.02em;
}

/* 四张磁贴各用一个色相，与参考产品一致（绿/深灰/紫/蓝） */
.tone-green {
  background: linear-gradient(140deg, #34d399, #10b981);
}

/* 原来是深灰渐变，放进同样深色的卡片后就糊在一起了 —— 整体提亮一档 */
.tone-dark {
  background: linear-gradient(140deg, #52525b, #3f3f46);
}

.tone-purple {
  background: linear-gradient(140deg, #a78bfa, #8b5cf6);
}

.tone-blue {
  background: linear-gradient(140deg, #60a5fa, #3b82f6);
}

/* 文字提亮到主色（原来是 tertiary 级别的灰，在卡片上偏暗） */
.tile-label {
  font-size: var(--font-md);
  color: var(--text-primary);
  text-align: center;
}

/* ── 分区 ── */
.section {
  padding: 0 var(--sp-4) var(--sp-5);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.section-title {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
}

.source-tabs {
  display: flex;
  gap: var(--sp-1);
}

.source-tab {
  min-height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: transparent;
}

.source-tab.is-active {
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
  font-weight: var(--weight-semibold);
}

/**
 * 横向滚动行（推荐歌单 / 编辑精选）。
 *
 * 为什么不做纵向双列网格：这两个分区各 20~30 张卡，纵排会把首页拉得很长
 * （实测两段加起来 49 张卡，要滑十几屏才能到底），而用户对“推荐/精选”
 * 大多是“随便看几张”的浏览行为 —— 横向一行既不占高度，也保留了可浏览性。
 */
.scroll-row {
  display: flex;
  gap: var(--sp-3);
  /* 上下留白给卡片的 :active 缩放留出空间，否则会被 overflow 裁掉 */
  padding: var(--sp-1) var(--sp-4) var(--sp-2);
  /*
   * 负外边距把滚动区向两侧延伸到屏幕边缘：卡片从页面内边距开始（视觉对齐），
   * 但滑到底时最后一张能完全滑进屏幕，不会被内边距卡住。
   */
  margin: 0 calc(var(--sp-4) * -1);
  /* 横向为主才响应横向拖拽，否则会和页面纵向滚动抢手势 */
  touch-action: pan-x;
  scroll-snap-type: x proximity;
  scroll-padding-left: var(--sp-4);
}

/* 卡片固定宽度：横向流里不能用 width:100%（那是网格的写法） */
.scroll-row :deep(.media-card) {
  flex: 0 0 132px;
  width: 132px;
  scroll-snap-align: start;
}

.footer-note {
  margin: var(--sp-4) 0 0;
  padding: 0 var(--sp-4);
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}
</style>
