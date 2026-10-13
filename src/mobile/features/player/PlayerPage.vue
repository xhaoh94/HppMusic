<script setup lang="ts">
/**
 * 全屏播放页。
 *
 * ## 布局：三段式底栏（对齐参考产品）
 *
 * ① 功能行：音效 · 音质 · 评论 · 收藏 · 更多
 * ② 进度条 + 左右时间
 * ③ 传输行：循环 · 上一首 · 播放 · 下一首 · 播放列表
 *
 * ⚠️ 当前只落**已经能真正工作**的部分：进度、传输、播放模式、队列、歌词。
 * 功能行里的音效/音质/评论/收藏要等各自能力接入后再上 ——
 * 铺一排点了没反应的图标比少一排更糟（本项目的一条明确原则）。
 *
 * ## 封面 ⇄ 歌词
 *
 * 横向滑动切换（左滑看词、右滑回封面），点封面也能切。
 * 两个面板都常驻挂载，只做 `transform` 平移 —— 这样歌词的滚动位置与
 * 自动跟随状态在来回切换时不会丢。
 *
 * ⚠️ 滑动阈值（72px）与纵向判定：手指在触屏上的滑动天然带纵向分量，
 * 不判断主方向的话，用户想滚动歌词会变成切到封面。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Slider from '@mobile/components/Slider.vue';
import Sheet from '@mobile/components/Sheet.vue';
import LyricsPanel from './LyricsPanel.vue';
import {
  formatTime,
  useNowPlaying,
  usePlayModeSwitcher,
  usePlaybackActions,
  useSmoothPosition,
} from '@mobile/adapters/player';
import {
  iconBack,
  iconMusic,
  iconNext,
  iconPause,
  iconPlay,
  iconPrevious,
  iconQueue,
} from '@mobile/icons';

const router = useRouter();
const { track, hasTrack, isPlaying, isLoading, coverUrl, title, artist } = useNowPlaying();
const { togglePlay, next, prev, seek, playFromActiveQueue, activeQueue } = usePlaybackActions();
const { cycle: cyclePlayMode, label: playModeLabel } = usePlayModeSwitcher();

/** 帧级外推的位置：进度条与歌词逐字都靠它，避免采样值一顿一顿 */
const { positionMs, durationMs, start: startClock, stop: stopClock } = useSmoothPosition();

const queueOpen = ref(false);
const scrubbing = ref(false);
const scrubValue = ref(0);

/** 'cover' | 'lyrics' */
const panel = ref<'cover' | 'lyrics'>('cover');

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
  // seek 期望秒
  void seek(value / 1000);
};

/* ── 横向滑动切换封面/歌词 ── */
const SWIPE_THRESHOLD = 72;
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
  // 纵向为主的滑动是在滚歌词，不切面板
  if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
  panel.value = dx < 0 ? 'lyrics' : 'cover';
};

const togglePanel = () => {
  panel.value = panel.value === 'cover' ? 'lyrics' : 'cover';
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
  // 播放页可能由直达链接打开（没有历史），此时回主页而不是留空白
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'home' });
};

onMounted(() => {
  startClock();
});

onBeforeUnmount(() => {
  stopClock();
});

// 切歌时重置封面失败标记，否则新歌会沿用上一首的失败状态
watch(coverUrl, () => {
  coverFailed.value = false;
});

const panelTransform = computed(() =>
  panel.value === 'lyrics' ? 'translateX(-50%)' : 'translateX(0)',
);
</script>

<template>
  <div class="player-page">
    <header class="player-header">
      <button type="button" class="icon-button" aria-label="收起" @click="goBack">
        <Icon :icon="iconBack" width="24" height="24" class="rotate-down" />
      </button>
      <div class="header-text" @click="togglePanel">
        <p class="header-title ellipsis">{{ title || '未在播放' }}</p>
        <p class="header-artist ellipsis">{{ artist }}</p>
      </div>
      <span class="icon-button" aria-hidden="true" />
    </header>

    <!-- 封面 / 歌词：同一个滑动容器里的两页 -->
    <div
      class="stage"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="tracking = false"
    >
      <div class="stage-track" :style="{ transform: panelTransform }">
        <section class="stage-panel stage-cover" @click="togglePanel">
          <div class="cover-wrap" :class="{ 'is-playing': isPlaying }">
            <img
              v-if="showCover"
              class="cover"
              :src="coverUrl"
              alt=""
              @error="coverFailed = true"
            />
            <div v-else class="cover cover-placeholder">
              <Icon :icon="iconMusic" width="56" height="56" />
            </div>
          </div>
        </section>

        <section class="stage-panel stage-lyrics">
          <LyricsPanel :position-ms="positionMs" :active="panel === 'lyrics'" />
        </section>
      </div>
    </div>

    <!-- 面板指示：两个短横线，当前页加宽 -->
    <div class="panel-dots" aria-hidden="true">
      <span class="panel-dot" :class="{ 'is-on': panel === 'cover' }" />
      <span class="panel-dot" :class="{ 'is-on': panel === 'lyrics' }" />
    </div>

    <div class="player-bar">
      <!-- ② 进度条 + 左右时间 -->
      <div class="progress-row">
        <span class="time">{{ displayTime }}</span>
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
        <span class="time">{{ durationText }}</span>
      </div>

      <!-- ③ 传输行：循环 · 上一首 · 播放 · 下一首 · 播放队列 -->
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

/* 收起用向下的箭头（表达"下滑关闭"），复用返回图标旋转 */
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

/* ── 舞台：封面与歌词两页横向滑动 ── */
.stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.stage-track {
  display: flex;
  width: 200%;
  height: 100%;
  transition: transform var(--duration-slow) var(--ease-standard);
}

.stage-panel {
  width: 50%;
  height: 100%;
  flex: 0 0 50%;
}

.stage-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
}

.cover-wrap {
  /* 正方形 + 不超过可用高度：横屏时封面不会把整页顶开 */
  width: min(100%, 56dvh);
  aspect-ratio: 1;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--fill-muted);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  transition: transform var(--duration-slow) var(--ease-standard);
}

/* 播放中轻微放大：给"正在响"一个静态可见的信号（不做旋转，大图旋转会让人晕） */
.cover-wrap.is-playing {
  transform: scale(1.015);
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

/* ── 面板指示 ── */
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

/* ── 底栏三段 ── */
.player-bar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-4) calc(var(--safe-bottom) + var(--sp-4));
}

.progress-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.progress-slider {
  flex: 1;
  min-width: 0;
}

.time {
  flex: 0 0 auto;
  min-width: 38px;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.transport-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
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
  top: 8px;
  right: 10px;
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

/* 加载中按钮做一个轻微的呼吸，表达"在忙"而不是"没反应" */
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
