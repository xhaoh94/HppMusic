<script setup lang="ts">
/**
 * 发现（主页第一个子页签）。
 *
 * P0 范围：入口磁贴 + **真实数据的每日推荐列表**。
 * 这里刻意不等 P2 才接数据：每日推荐是唯一一条「登录 → 设备注册 → 加密请求 →
 * 解密响应 → 映射为 Song」的完整链路，把它跑通就等于端到端验证了桥、鉴权与打包产物；
 * 留到后面接，等于把最大的不确定性放到最后。
 *
 * 播放暂未接线（P2 接 player store + 原生播放器），点歌给出明确提示而不是静默无反应。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import type { IconifyIcon } from '@iconify/types';
import EmptyState from '@mobile/components/EmptyState.vue';
import SongRow from '@mobile/components/SongRow.vue';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import { getEverydayRecommend } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import type { Song } from '@/models/song';
import { iconAlbum, iconMusicOff, iconSearch } from '@mobile/icons';
import { usePlaybackActions } from '@mobile/adapters/player';

const router = useRouter();
const toast = useToastStore();
const { playSong } = usePlaybackActions();

type LoadState = 'loading' | 'ready' | 'error';

const state = ref<LoadState>('loading');
const songs = ref<Song[]>([]);
const failureReason = ref('');

interface Tile {
  key: string;
  title: string;
  subtitle: string;
  icon: IconifyIcon;
  tone: string;
  available: boolean;
}

const tiles: Tile[] = [
  {
    key: 'daily',
    title: '每日推荐',
    subtitle: '为你而选',
    icon: iconAlbum,
    tone: 'accent',
    available: true,
  },
  {
    key: 'search',
    title: '搜索',
    subtitle: '找歌、歌手、歌单',
    icon: iconSearch,
    tone: 'neutral',
    available: true,
  },
  {
    key: 'ranking',
    title: '排行榜',
    subtitle: '即将支持',
    icon: iconAlbum,
    tone: 'muted',
    available: false,
  },
  {
    key: 'recognize',
    title: '听歌识曲',
    subtitle: '即将支持',
    icon: iconMusicOff,
    tone: 'muted',
    available: false,
  },
];

const scrollToDaily = () => {
  document.getElementById('daily-recommend')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const onTile = (tile: Tile) => {
  if (tile.key === 'search') {
    void router.push({ name: 'search' });
    return;
  }
  if (tile.key === 'daily') {
    scrollToDaily();
    return;
  }
  toast.info(`「${tile.title}」正在开发中`);
};

const load = async () => {
  state.value = 'loading';
  failureReason.value = '';
  try {
    const response = await getEverydayRecommend();
    const mapped = (extractList(response) as unknown[]).map((item) => mapTopSong(item));
    songs.value = mapped;
    state.value = 'ready';
    logger.info('Home', 'Daily recommend loaded:', mapped.length);
  } catch (error) {
    logger.warn('Home', 'Daily recommend failed', error);
    failureReason.value = error instanceof Error ? error.message : String(error);
    state.value = 'error';
  }
};

/**
 * 点歌。
 *
 * 整个每日推荐列表作为播放上下文传进去，而不是只播这一首 —— 否则播完就停了，
 * 用户得自己一首首点。队列 id 用固定的字符串（而不是每次生成），
 * 这样在首页重复点歌不会攒出一堆内容相同的队列。
 */
const onSelect = async (song: Song) => {
  const started = await playSong(song, songs.value, {
    queueId: 'queue:mobile-daily',
    title: '每日推荐',
    subtitle: '',
  });
  if (!started) toast.warning('这首歌暂时无法播放，试试别的');
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="home-page scroll-y">
    <section class="tiles">
      <button
        v-for="tile in tiles"
        :key="tile.key"
        type="button"
        class="tile"
        :class="[`tone-${tile.tone}`, { 'is-muted': !tile.available }]"
        @click="onTile(tile)"
      >
        <span class="tile-icon">
          <Icon :icon="tile.icon" width="18" height="18" />
        </span>
        <span class="tile-text">
          <span class="tile-title">{{ tile.title }}</span>
          <span class="tile-subtitle">{{ tile.subtitle }}</span>
        </span>
      </button>
    </section>

    <section id="daily-recommend" class="section">
      <header class="section-header">
        <h2 class="section-title">每日推荐</h2>
        <button type="button" class="section-action" @click="load">换一批</button>
      </header>

      <EmptyState
        v-if="state === 'loading'"
        tone="loading"
        title="正在加载"
        description="正在获取今日推荐"
      />
      <EmptyState
        v-else-if="state === 'error'"
        tone="error"
        title="加载失败"
        :description="failureReason"
        action-label="重试"
        @action="load"
      />
      <EmptyState
        v-else-if="!songs.length"
        title="今天还没有推荐"
        description="稍后再试试，或者先搜索你想听的歌"
        action-label="去搜索"
        @action="router.push({ name: 'search' })"
      />
      <div v-else class="song-list">
        <SongRow v-for="song in songs" :key="song.id || song.hash" :song="song" @select="onSelect" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  height: 100%;
}

/* ── 入口磁贴：两列，等宽 ── */
.tiles {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4) var(--sp-5);
}

.tile {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 64px;
  padding: var(--sp-3);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
  border: 1px solid var(--divider);
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.tile:active {
  transform: scale(0.98);
}

.tile.is-muted {
  opacity: 0.55;
}

.tile-icon {
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--fill-muted);
  color: var(--text-secondary);
}

.tone-accent .tile-icon {
  color: var(--accent);
  background: var(--accent-soft);
}

.tile-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tile-title {
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.tile-subtitle {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── 区块 ── */
.section {
  padding-bottom: var(--sp-6);
}

.section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-4);
}

.section-title {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
}

.section-action {
  min-height: 32px;
  padding: 0 var(--sp-2);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.song-list {
  display: flex;
  flex-direction: column;
}
</style>
