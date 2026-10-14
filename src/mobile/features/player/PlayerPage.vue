<script setup lang="ts">
/**
 * 全屏播放页。
 *
 * ## 布局（对齐旧项目的竖排版式）
 *
 * ```
 * [‹ 返回]                      ← 顶栏只放返回（不重复歌名：下方就有）
 *        [封面]                 ← 随视图模式变化
 *      [歌名（大）]
 *      [歌手（小）]
 *   [歌词滚动区（flex:1）]
 * [功能行：音效 音质 评论 收藏 更多]
 * [进度条（整宽）]
 * [时间行：已播 / 总长]
 * [传输行：模式 上一首 播放 下一首 队列]
 * ```
 *
 * 之前做成了"横向三页（封面/歌词/写真）+ 页指示点 + 顶栏居中歌名与模式标签"——
 * 那是参考产品的另一套版式，但**与旧项目不一致**（用户明确指出）。现在改为：
 * 封面、歌名、歌手、歌词**纵向排在同一页**，三种视图只改变"主视觉"那一块。
 *
 * ## 三种视图（换肤）
 *
 * · **封面** —— 封面大图 + 下方当前行歌词
 * · **简约歌词** —— 隐藏封面，把整块空间让给歌词
 * · **写真** —— 歌手写真**全屏铺满**（含顶栏/底栏区域的背景），歌词浮在上面
 *
 * 写真之所以要全屏：旧项目就是全屏的（顶栏与底栏浮在写真之上），
 * 只在"内容区"里放写真是我上一版的错误。
 *
 * 切入口两处：**点封面区域循环切换** + 「更多 → 换肤」明确列出（对齐旧项目的菜单）。
 * 模式记在 `settingStore.lyricViewMode`，播放页与菜单读同一份，不会两处不一致。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Slider from '@mobile/components/Slider.vue';
import Sheet from '@mobile/components/Sheet.vue';
import CoverPanel from './CoverPanel.vue';
import LyricsPanel from './LyricsPanel.vue';
import QualitySheet from './QualitySheet.vue';
import EffectSheet from './EffectSheet.vue';
import MoreSheet, { type PlayerSkin } from './MoreSheet.vue';
import AddToPlaylistSheet from './AddToPlaylistSheet.vue';
import CommentSheet from './CommentSheet.vue';
import BarrageLayer from './BarrageLayer.vue';
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
  iconAudioWave,
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
  iconRepeat,
  iconRepeatOnce,
  iconShuffle,
} from '@mobile/icons';

const router = useRouter();
const setting = useSettingStore();
const toast = useToastStore();

const { track, hasTrack, isPlaying, isLoading, title, artist } = useNowPlaying();
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
const { cycle: cyclePlayMode, current: playMode, label: playModeLabel } = usePlayModeSwitcher();
const { currentIndex: lyricIndex, lines: lyricLines } = useLyrics();

/** 帧级外推的位置：进度条与歌词逐字都靠它，避免采样值一顿一顿 */
const { positionMs, durationMs, start: startClock, stop: stopClock } = useSmoothPosition();

/** 写真轮播（图片来自内核 getAudioImages，间隔/开关跟随设置） */
const portrait = useArtistPortraits(track, {
  carouselEnabled: computed(() => Boolean(setting.lyricCarouselEnabled)),
  carouselInterval: computed(() => Number(setting.lyricCarouselInterval) || 15),
});

/* ── 视图模式（与 settingStore 同步，保证「更多 → 换肤」与这里一致） ── */

const SKINS: { value: PlayerSkin; label: string; hint: string }[] = [
  { value: 'cover', label: '封面', hint: '封面大图 + 当前歌词' },
  { value: 'lyric', label: '简约歌词', hint: '隐藏封面，歌词占满' },
  { value: 'portrait', label: '写真', hint: '歌手写真全屏铺满' },
];

/**
 * 上游的 `lyricViewMode` 还包含 `amll`（Apple Music 风格逐字歌词），
 * 那需要一整套 WebGL 渲染栈，移动端不做 —— 遇到就回落到封面模式。
 */
const normalizeSkin = (value: unknown): PlayerSkin => {
  if (value === 'lyric' || value === 'portrait') return value;
  return 'cover';
};

const skin = ref<PlayerSkin>(normalizeSkin(setting.lyricViewMode));
watch(
  () => setting.lyricViewMode,
  (value) => {
    const next = normalizeSkin(value);
    if (next !== skin.value) skin.value = next;
  },
);

const setSkin = (value: PlayerSkin) => {
  skin.value = value;
  // 写回设置：桌面端的皮肤键是 host:cover / host:portrait，lyric 用默认键
  setting.lyricViewMode = value === 'lyric' ? 'lyric' : value;
};

const cycleSkin = () => {
  const index = SKINS.findIndex((item) => item.value === skin.value);
  const next = SKINS[(index + 1) % SKINS.length];
  setSkin(next.value);
  toast.info(`视图：${next.label}`);
};

const isPortrait = computed(() => skin.value === 'portrait');
const showCover = computed(() => skin.value === 'cover');
/** 封面模式的氛围背景 = 同一张封面（同一张图放大模糊，零额外网络与内存） */
const coverBackdrop = computed(() => track.value?.coverUrl || track.value?.cover || '');

/** 弹幕要以歌曲 hash 拉取（不是 mixSongId）；没有 hash 就不渲染这一层 */
const barrageHash = computed(() => String(track.value?.hash ?? ''));

/* ── 播放模式图标（循环按钮不用文字） ── */
const playModeIcon = computed(() => {
  if (playMode.value === 'single') return iconRepeatOnce;
  if (playMode.value === 'random') return iconShuffle;
  return iconRepeat;
});

/* ── 进度 ── */
const queueOpen = ref(false);
const qualityOpen = ref(false);
const effectOpen = ref(false);
const moreOpen = ref(false);
const addToPlaylistOpen = ref(false);
const commentOpen = ref(false);

/**
 * 「更多」里点开另一个面板时，先把「更多」收起再开下一个。
 *
 * 两个 `Sheet` 都 `Teleport to body` 且共用同一个 `--z-sheet` —— 同时挂载会两层
 * 遮罩叠在一起（点关闭可能关错层）。所以等退场动画（`--duration-normal` = 200ms）
 * 走完再开，220ms 留一点余量。
 */
const switchSheet = (open: (value: boolean) => void) => {
  moreOpen.value = false;
  window.setTimeout(() => open(true), 220);
};

const scrubbing = ref(false);
const scrubValue = ref(0);

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

/** 封面模式下方显示的当前行歌词 */
const currentLine = computed(() => {
  const index = lyricIndex.value;
  if (index < 0) return '';
  return lyricLines.value[index]?.text ?? '';
});

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
</script>

<template>
  <div class="player-page" :class="{ 'is-portrait': isPortrait }">
    <!-- 写真全屏背景：absolute 铺满整个视口，内容浮在它之上（旧项目就是全屏的） -->
    <div v-if="isPortrait" class="portrait-backdrop" aria-hidden="true">
      <Transition name="portrait-fade" mode="out-in">
        <img
          v-if="portrait.currentUrl.value || track?.coverUrl"
          :key="portrait.index.value"
          class="portrait-image"
          :src="portrait.currentUrl.value || track?.coverUrl || ''"
          alt=""
        />
      </Transition>
      <div class="portrait-veil" />
    </div>

    <!-- 封面模式的氛围背景：同一张封面放大模糊（等比写真模式的做法，两张机制统一） -->
    <div v-else-if="showCover && coverBackdrop" class="cover-backdrop" aria-hidden="true">
      <img class="cover-backdrop-image" :src="coverBackdrop" alt="" />
      <div class="cover-backdrop-veil" />
    </div>

    <header class="player-header">
      <button type="button" class="icon-button" aria-label="收起" @click="goBack">
        <Icon :icon="iconBack" width="24" height="24" class="chevron" />
      </button>
      <span class="header-spacer" aria-hidden="true" />
    </header>

    <div class="player-stage" :class="{ 'is-lyrics-only': skin === 'lyric' }">
      <!-- 弹幕：浮在主视觉（封面 / 歌词）之上，在底栏之下 -->
      <BarrageLayer v-if="barrageHash" :hash="barrageHash" :playing="isPlaying" />

      <!-- 封面（仅封面模式） -->
      <CoverPanel
        v-if="showCover"
        :track="track"
        :current-line="currentLine"
        :playing="isPlaying"
        @click="cycleSkin"
      />

      <!-- 歌名 / 歌手：三种模式都显示（旧项目也是常驻） -->
      <div class="track-info">
        <p class="track-title ellipsis">{{ title || '未在播放' }}</p>
        <p class="track-artist ellipsis">{{ artist }}</p>
      </div>

      <!-- 歌词：三种模式都显示；写真模式下浮在背景上 -->
      <LyricsPanel :position-ms="positionMs" :active="true" class="lyrics-area" />
    </div>

    <div class="player-bar">
      <!-- ① 功能行（四项，对齐旧项目：音效已收进「更多」） -->
      <div class="func-row">
        <button type="button" class="func-button" aria-label="音质" @click="qualityOpen = true">
          <Icon :icon="iconAudioWave" width="22" height="22" />
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
          <Icon :icon="playModeIcon" width="22" height="22" />
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
          <Icon v-if="isLoading" :icon="iconPlay" width="34" height="34" class="pulse" />
          <Icon v-else :icon="isPlaying ? iconPause : iconPlay" width="34" height="34" />
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
  <MoreSheet
    v-model="moreOpen"
    :skin="skin"
    @update:skin="setSkin"
    @open-effect="switchSheet((open) => (effectOpen = open))"
    @open-add-to-playlist="switchSheet((open) => (addToPlaylistOpen = open))"
  />
  <AddToPlaylistSheet v-model="addToPlaylistOpen" :song="track" />
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
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  overflow: hidden;
}

/* ── 封面模式的氛围背景 ── */
.cover-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}

.cover-backdrop-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 大幅模糊 + 压暗：只留色彩氛围，不抢主封面，也不影响文字可读性 */
  filter: blur(48px) saturate(1.3);
  transform: scale(1.25);
  opacity: 0.5;
}

.cover-backdrop-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.3),
    rgba(0, 0, 0, 0.55) 60%,
    rgba(0, 0, 0, 0.75)
  );
}

/* ── 写真全屏背景 ── */
.portrait-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.portrait-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: portrait-breathe 18s var(--ease-standard) infinite alternate;
}

@keyframes portrait-breathe {
  from {
    transform: scale(1.04);
  }
  to {
    transform: scale(1.12);
  }
}

/* 上下压暗：中间留给写真，两端保证歌名与底栏可读 */
.portrait-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.55) 0%,
    rgba(0, 0, 0, 0.18) 28%,
    rgba(0, 0, 0, 0.45) 68%,
    rgba(0, 0, 0, 0.78) 100%
  );
}

.portrait-fade-enter-active,
.portrait-fade-leave-active {
  transition: opacity 900ms var(--ease-standard);
}

.portrait-fade-enter-from,
.portrait-fade-leave-to {
  opacity: 0;
}

/* 内容整体浮在写真之上 */
.player-header,
.player-stage,
.player-bar {
  position: relative;
  z-index: 1;
}

/* ── 顶栏：只放返回（歌名在下方，不重复） ── */
.player-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
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
  background: var(--fill-subtle);
}

/* 返回箭头用 chevron 左（旧项目也是这个）：不是"下拉收起" */
.chevron {
  transform: none;
}

.is-portrait .icon-button {
  color: #fff;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}

.header-spacer {
  flex: 1;
}

/* ── 中部：封面 / 歌名 / 歌词 纵向排列 ── */
.player-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 简约歌词：歌词占满剩余空间，不需要额外处理；封面不渲染即可 */
.player-stage.is-lyrics-only {
  padding-top: var(--sp-2);
}

.track-info {
  flex: 0 0 auto;
  padding: var(--sp-3) var(--sp-5) var(--sp-2);
  text-align: center;
}

.track-title {
  margin: 0 0 2px;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
}

.track-artist {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

/* 写真模式：歌名/歌手压在写真上，需要提高可读性 */
.is-portrait .track-title {
  color: #fff;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
}

.is-portrait .track-artist {
  color: rgba(255, 255, 255, 0.72);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}

/* 歌词区：吃掉剩余高度 */
.lyrics-area {
  flex: 1;
  min-height: 0;
}

/* 写真上的歌词要更亮（底色是任意图片） */
.is-portrait .lyrics-area :deep(.line) {
  color: rgba(255, 255, 255, 0.55);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55);
}

.is-portrait .lyrics-area :deep(.line.is-near) {
  color: rgba(255, 255, 255, 0.75);
}

.is-portrait .lyrics-area :deep(.line.is-active) {
  color: #fff;
}

.is-portrait .lyrics-area :deep(.line-sub) {
  color: rgba(255, 255, 255, 0.6);
}

.is-portrait .lyrics-area :deep(.lyrics-empty-text) {
  color: rgba(255, 255, 255, 0.7);
}

/* ── 底栏 ── */
.player-bar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--safe-bottom) + var(--sp-3));
}

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

/* 写真模式下底栏图标要亮起来（背景是图片） */
.is-portrait .func-button {
  color: rgba(255, 255, 255, 0.82);
}

.is-portrait .func-button.is-active {
  color: var(--accent);
}

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

.is-portrait .time {
  color: rgba(255, 255, 255, 0.7);
}

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

.is-portrait .transport-button {
  color: #fff;
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
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 无背景：用户明确要求，也跟相邻传输键同一种视觉语言
     （旧项目全屏播放页的播放键是一层 5% 极淡底，视觉上几乎等同于没有背景） */
  min-width: 60px;
  min-height: 56px;
  border-radius: 50%;
  color: var(--text-primary);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.play-button:active:not(:disabled) {
  transform: scale(0.92);
  background: var(--fill-subtle);
}

.is-portrait .play-button {
  color: #fff;
}

.play-button:disabled {
  opacity: 0.35;
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
