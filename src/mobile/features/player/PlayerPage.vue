<script setup lang="ts">
/**
 * 全屏播放页。
 *
 * ## 三段式底栏（按参考产品/旧项目的版式）
 *
 * ```
 * [音效] [音质] [收藏] [更多]      ← ① 功能行
 * ━━━━━━━━━━━━━━━━━━              ← ② 进度条（独立一行，整宽）
 * 00:00                    04:14   ←    时间行
 *  ↻     ⏮     ▶     ⏭     ≡³    ← ③ 传输行
 * ```
 *
 * ⚠️ 进度条**单独一行**、时间在它下面 —— 不是"时间—进度条—时间"同一行。
 * 参考产品就是这么排的：进度条整宽可拖（触屏上拖拽区越大越好），
 * 时间放下面当读数。之前我按桌面版式做成了同一行，拖动区只有一半宽。
 *
 * ## 三种视图模式（横向三页）
 *
 * 封面 / 简约歌词 / 写真，左右滑动或点标题切换。
 * 三页都常驻挂载，只做 transform 平移 —— 这样歌词的滚动位置与自动跟随
 * 在来回切换时不会丢。
 *
 * ## 功能行 5 项
 *
 * 音效 · 音质 · 评论 · 收藏 · 更多。
 * 评论为**只读列表**：内核 `api/comment.ts` 只有取数据的接口，没有点赞/发表，
 * 所以面板里不渲染可点的心形（放一个点不动的按钮比不显示更糟）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Slider from '@mobile/components/Slider.vue';
import Sheet from '@mobile/components/Sheet.vue';
import CoverPanel from './CoverPanel.vue';
import PortraitPanel from './PortraitPanel.vue';
import LyricsPanel from './LyricsPanel.vue';
import QualitySheet from './QualitySheet.vue';
import EffectSheet from './EffectSheet.vue';
import MoreSheet from './MoreSheet.vue';
import CommentSheet from './CommentSheet.vue';
import {
  formatTime,
  useLyrics,
  useNowPlaying,
  usePlayModeSwitcher,
  usePlaybackActions,
  useSmoothPosition,
} from '@mobile/adapters/player';
import { useArtistPortraits } from '@mobile/adapters/portrait';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import {
  iconBack,
  iconFavorite,
  iconMessageCircle,
  iconMore,
  iconMusic,
  iconNext,
  iconPause,
  iconPlay,
  iconPrevious,
  iconQueue,
  iconSlidersHorizontal,
  iconVolume,
} from '@mobile/icons';

const router = useRouter();
const setting = useSettingStore();
const toast = useToastStore();

const { track, hasTrack, isPlaying, isLoading, coverUrl, title, artist } = useNowPlaying();
const {
  togglePlay,
  next,
  prev,
  seek,
  playFromActiveQueue,
  activeQueue,
  isCurrentFavorite,
  toggleFavorite,
} = usePlaybackActions();
const { cycle: cyclePlayMode, label: playModeLabel } = usePlayModeSwitcher();
const { currentIndex: lyricIndex, lines: lyricLines } = useLyrics();

/** 帧级外推的位置：进度条与歌词逐字都靠它，避免采样值一顿一顿 */
const { positionMs, durationMs, start: startClock, stop: stopClock } = useSmoothPosition();

/** 写真轮播（图片来自内核 getAudioImages，间隔/开关跟随设置） */
const portrait = useArtistPortraits(track, {
  carouselEnabled: computed(() => Boolean(setting.lyricCarouselEnabled)),
  carouselInterval: computed(() => Number(setting.lyricCarouselInterval) || 15),
});

type Panel = 'cover' | 'lyrics' | 'portrait';
const PANELS: Panel[] = ['cover', 'lyrics', 'portrait'];
const PANEL_LABELS: Record<Panel, string> = {
  cover: '封面',
  lyrics: '歌词',
  portrait: '写真',
};

const panel = ref<Panel>(setting.lyricViewMode === 'portrait' ? 'portrait' : 'cover');
const panelIndex = computed(() => PANELS.indexOf(panel.value));

const queueOpen = ref(false);
const qualityOpen = ref(false);
const effectOpen = ref(false);
const moreOpen = ref(false);
const commentOpen = ref(false);

const scrubbing = ref(false);
const scrubValue = ref(0);
const coverFailed = ref(false);

const showCover = computed(() => Boolean(coverUrl.value) && !coverFailed.value);

const displayPositionMs = computed(() =>
  scrubbing.value ? scrubValue.value : positionMs.value,
);
const displayTime = computed(() => formatTime(displayPositionMs.value / 1000));
const durationText = computed(() => formatTime(durationMs.value / 1000));

const progressValue = computed({
  get: () => (scrubbing.value ? scrubValue.value : positionMs.value),
  set: (value: number) => {
    scrubValue.value = value;
  },
});

const onProgressCommit = (value: number) => {
  scrubbing.value = false;
  void seek(value / 1000);
};

/** 封面页下方显示的当前行歌词 */
const currentLine = computed(() => {
  const index = lyricIndex.value;
  if (index < 0) return '';
  return lyricLines.value[index]?.text ?? '';
});

/* ── 横向滑动切换三页 ── */
const SWIPE_THRESHOLD = 64;
let pointerStartX = 0;
let pointerStartY = 0;
let tracking = false;

const onPointerDown = (event: PointerEvent) => {
  pointerStartX = event.clientX;
  pointerStartY = event.clientY;
  tracking = true;
};

const onPointerUp = (event: PointerEvent) => {
  if (!tracking) return;
  tracking = false;
  const dx = event.clientX - pointerStartX;
  const dy = event.clientY - pointerStartY;
  // 纵向为主的滑动是在滚歌词，不切页
  if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
  const step = dx < 0 ? 1 : -1;
  const nextIndex = panelIndex.value + step;
  if (nextIndex < 0 || nextIndex >= PANELS.length) return;
  panel.value = PANELS[nextIndex];
};

const cyclePanel = () => {
  panel.value = PANELS[(panelIndex.value + 1) % PANELS.length];
};

/* ── 功能行 ── */
const onToggleFavorite = async () => {
  const song = track.value;
  if (!song) return;
  try {
    const nowFavorite = await toggleFavorite(song);
    toast.success(nowFavorite ? '已加入「我喜欢」' : '已取消收藏');
  } catch (error) {
    logger.warn('Player', 'Toggle favorite failed', error);
    toast.danger(error instanceof Error ? error.message : '操作失败，请稍后重试');
  }
};

/* ── 队列 ── */
const queueSongs = computed(() => activeQueue.value?.songs ?? []);
const queueTitle = computed(() => activeQueue.value?.title || '播放队列');
const currentQueueIndex = computed(() => {
  const id = String(track.value?.id ?? '');
  if (!id) return -1;
  return queueSongs.value.findIndex((song) => String(song.id) === id);
});

const jumpTo = async (songId: string) => {
  await playFromActiveQueue(songId);
  queueOpen.value = false;
};

const goBack = () => {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'home' });
};

onMounted(() => {
  startClock();
});
onBeforeUnmount(() => {
  stopClock();
});

watch(coverUrl, () => {
  coverFailed.value = false;
});

// 用户切过视图后记进设置，下次进播放页沿用
watch(panel, (value) => {
  if (value === 'portrait') setting.lyricViewMode = 'portrait';
  else if (value === 'cover') setting.lyricViewMode = 'cover';
});

const trackTransform = computed(() => `translateX(-${panelIndex.value * (100 / PANELS.length)}%)`);
</script>

<template>
  <div class="player-page">
    <header class="player-header">
      <button type="button" class="icon-button" aria-label="收起" @click="goBack">
        <Icon :icon="iconBack" width="24" height="24" class="rotate-down" />
      </button>
      <div class="header-text" @click="cyclePanel">
        <p class="header-title ellipsis">{{ title || '未在播放' }}</p>
        <p class="header-artist ellipsis">{{ artist }}</p>
      </div>
      <button type="button" class="panel-switch" @click="cyclePanel">
        {{ PANEL_LABELS[panel] }}
      </button>
    </header>

    <!-- 三页：封面 / 歌词 / 写真 -->
    <div
      class="stage"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="tracking = false"
    >
      <div class="stage-track" :style="{ transform: trackTransform }">
        <section class="stage-panel">
          <CoverPanel
            :track="track"
            :current-line="currentLine"
            :playing="isPlaying"
            @click="panel = 'lyrics'"
          />
        </section>
        <section class="stage-panel">
          <LyricsPanel :position-ms="positionMs" :active="panel === 'lyrics'" />
        </section>
        <section class="stage-panel">
          <PortraitPanel
            :track="track"
            :position-ms="positionMs"
            :active="panel === 'portrait'"
            :portrait-url="portrait.currentUrl.value"
            :portrait-index="portrait.index.value"
          />
        </section>
      </div>
    </div>

    <div class="panel-dots" aria-hidden="true">
      <span
        v-for="item in PANELS"
        :key="item"
        class="panel-dot"
        :class="{ 'is-on': panel === item }"
      />
    </div>

    <div class="player-bar">
      <!-- ① 功能行 -->
      <div class="func-row">
        <button type="button" class="func-button" aria-label="音效" @click="effectOpen = true">
          <Icon :icon="iconSlidersHorizontal" width="22" height="22" />
        </button>
        <button type="button" class="func-button" aria-label="音质" @click="qualityOpen = true">
          <Icon :icon="iconVolume" width="22" height="22" />
        </button>
        <button type="button" class="func-button" aria-label="评论" @click="commentOpen = true">
          <Icon :icon="iconMessageCircle" width="22" height="22" />
        </button>
        <button
          type="button"
          class="func-button"
          :class="{ 'is-active': isCurrentFavorite }"
          :aria-label="isCurrentFavorite ? '取消收藏' : '收藏'"
          @click="onToggleFavorite"
        >
          <Icon :icon="iconFavorite" width="22" height="22" />
        </button>
        <button type="button" class="func-button" aria-label="更多" @click="moreOpen = true">
          <Icon :icon="iconMore" width="22" height="22" />
        </button>
      </div>

      <!-- ② 进度条：整宽独立一行 -->
      <Slider
        v-model="progressValue"
        class="progress-slider"
        :min="0"
        :max="durationMs || 1"
        :disabled="!hasTrack || durationMs <= 0"
        label="播放进度"
        @dragging="scrubbing = $event"
        @commit="onProgressCommit"
      />

      <!-- 时间行（进度条下方） -->
      <div class="time-row">
        <span class="time">{{ displayTime }}</span>
        <span class="time">{{ durationText }}</span>
      </div>

      <!-- ③ 传输行 -->
      <div class="transport-row">
        <button
          type="button"
          class="transport-button is-small"
          :aria-label="playModeLabel"
          @click="cyclePlayMode()"
        >
          <span class="mode-label">{{ playModeLabel.slice(0, 2) }}</span>
        </button>

        <button
          type="button"
          class="transport-button"
          aria-label="上一首"
          :disabled="!hasTrack"
          @click="prev()"
        >
          <Icon :icon="iconPrevious" width="30" height="30" />
        </button>

        <button
          type="button"
          class="play-button"
          :aria-label="isPlaying ? '暂停' : '播放'"
          :disabled="!hasTrack && !queueSongs.length"
          @click="togglePlay()"
        >
          <Icon v-if="isLoading" :icon="iconPlay" width="26" height="26" class="pulse" />
          <Icon v-else :icon="isPlaying ? iconPause : iconPlay" width="26" height="26" />
        </button>

        <button
          type="button"
          class="transport-button"
          aria-label="下一首"
          :disabled="!hasTrack"
          @click="next()"
        >
          <Icon :icon="iconNext" width="30" height="30" />
        </button>

        <button
          type="button"
          class="transport-button is-small queue-button"
          aria-label="播放队列"
          @click="queueOpen = true"
        >
          <Icon :icon="iconQueue" width="22" height="22" />
          <span v-if="queueSongs.length" class="queue-count">{{ queueSongs.length }}</span>
        </button>
      </div>
    </div>
  </div>

  <QualitySheet v-model="qualityOpen" />
  <EffectSheet v-model="effectOpen" />
  <MoreSheet v-model="moreOpen" />
  <CommentSheet v-model="commentOpen" />

  <Sheet v-model="queueOpen" :title="queueTitle">
    <p v-if="!queueSongs.length" class="queue-empty">队列是空的，去首页挑一首吧</p>
    <button
      v-for="(song, index) in queueSongs"
      :key="`${song.id}-${index}`"
      type="button"
      class="queue-item"
      :class="{ 'is-current': index === currentQueueIndex }"
      @click="jumpTo(String(song.id))"
    >
      <span class="queue-index" aria-hidden="true">
        <template v-if="index === currentQueueIndex && isPlaying">▶</template>
        <template v-else>{{ index + 1 }}</template>
      </span>
      <span class="queue-meta">
        <span class="queue-title ellipsis">{{ song.title || song.name }}</span>
        <span class="queue-artist ellipsis">{{ song.artist }}</span>
      </span>
    </button>
  </Sheet>
</template>

<style scoped>
.player-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
}

/* ── 顶栏 ── */
.player-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--safe-top) var(--sp-3) 0;
}

.icon-button {
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--text-primary);
}

.icon-button:active {
  background: var(--fill-muted);
}

.rotate-down {
  transform: rotate(-90deg);
}

.header-text {
  flex: 1;
  min-width: 0;
  text-align: center;
}

.header-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
}

.header-artist {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

/* 视图模式当前值：点一下循环切换（比三个点更省空间） */
.panel-switch {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

/* ── 舞台：三页横向 ── */
.stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.stage-track {
  display: flex;
  width: 300%;
  height: 100%;
  transition: transform var(--duration-slow) var(--ease-standard);
}

.stage-panel {
  width: calc(100% / 3);
  flex: 0 0 calc(100% / 3);
  height: 100%;
}

/* ── 页指示 ── */
.panel-dots {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 16px;
}

.panel-dot {
  width: 12px;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--divider-strong);
  transition:
    width var(--duration-normal) var(--ease-standard),
    background var(--duration-normal) var(--ease-standard);
}

.panel-dot.is-on {
  width: 20px;
  background: var(--accent);
}

/* ── 底栏 ── */
.player-bar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--safe-bottom) + var(--sp-3));
}

/* ① 功能行 */
.func-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-2) var(--sp-1);
}

.func-button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}

.func-button:active {
  background: var(--fill-subtle);
  color: var(--text-primary);
}

.func-button.is-active {
  color: var(--accent);
}

/* ② 进度条（整宽） */
.progress-slider {
  width: 100%;
}

.time-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-1);
}

.time {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ③ 传输行 */
.transport-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}

.transport-button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  border-radius: var(--radius-md);
  color: var(--text-primary);
}

.transport-button:disabled {
  opacity: 0.35;
}

.transport-button:active:not(:disabled) {
  background: var(--fill-subtle);
}

.mode-label {
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.queue-button {
  position: relative;
}

.queue-count {
  position: absolute;
  top: 6px;
  right: 12px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
  font-size: 10px;
  line-height: 16px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.play-button {
  flex: 0 0 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  color: var(--accent-on);
  background: var(--accent);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.play-button:active:not(:disabled) {
  transform: scale(0.94);
}

.play-button:disabled {
  opacity: 0.45;
}

.pulse {
  animation: pulse 1.1s var(--ease-standard) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* ── 队列 ── */
.queue-empty {
  margin: var(--sp-6) 0;
  text-align: center;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.queue-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--sp-1);
  border-radius: var(--radius-sm);
  text-align: left;
}

.queue-item:active {
  background: var(--fill-subtle);
}

.queue-index {
  flex: 0 0 22px;
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.queue-item.is-current .queue-index,
.queue-item.is-current .queue-title {
  color: var(--accent);
}

.queue-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.queue-title {
  font-size: var(--font-md);
}

.queue-artist {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
</style>
