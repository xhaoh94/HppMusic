<script setup lang="ts">
/**
 * 歌曲行。
 *
 * 触屏版与桌面行的区别不是"样式差一点"，是交互模型不同：
 * · 没有 hover —— 序号/播放图标常驻显示，不做「悬停才出现」
 * · 没有右键 —— 次级操作靠长按（P2 接），这里先把 `longpress` 事件抛出去
 * · 最小高度 56px 起步，整行可点，不做只有文字可点的小热区
 */
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { iconMusic } from '@mobile/icons';
import { songKeyOf } from '@mobile/utils/songKey';
import { getSongDerivedState } from '@/utils/song';
import type { Song } from '@/models/song';

const props = withDefaults(
  defineProps<{
    song: Song;
    index?: number;
    /** 是否显示序号（榜单/歌单列表用） */
    showIndex?: boolean;
    /** 当前播放中的曲目 */
    active?: boolean;
  }>(),
  { index: -1, showIndex: false, active: false },
);

/**
 * 定位键：写在 DOM 的 `data-song-key` 上，供「定位到当前播放」查找本行。
 * 取值规则见 @mobile/utils/songKey。
 */
const songKey = computed(() => songKeyOf(props.song));

const emit = defineEmits<{ select: [song: Song]; longpress: [song: Song] }>();

const cover = computed(() => props.song.coverUrl || props.song.cover || '');
const artist = computed(() => props.song.artist || props.song.albumName || '未知歌手');

/**
 * 音质 / 特权标签。
 *
 * 不在这里自己判 `payType`、`privilege`、`relateGoods`：内核的 `getSongDerivedState`
 * 已经把这套规则收好了 —— `qualityTag` 按 relateGoods 里有没有 flac/320/high 得出
 * SQ / HQ / Hi-Res，`privilegeTags` 按 privilege + payType 得出 付费 / VIP / 版权 / 音源。
 * 这里只负责渲染，规则漂移（上游改字段含义）只需要改内核那一份。
 */
const derived = computed(() => getSongDerivedState(props.song));
const qualityTag = computed(() => derived.value.qualityTag);
const privilegeTags = computed(() => derived.value.privilegeTags);
const durationText = computed(() => {
  /**
   * ⚠️ `song.duration` 的单位是**秒**（上游 `formatDuration(seconds)` 为此）。
   * 按毫秒算的话每首歌都会显示 0:00，而且不会报错。
   */
  const total = Number(props.song.duration || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
});

/**
 * 长按识别。
 *
 * 用 500ms 阈值 + 指针移动超过 10px 取消：手指滑动列表时必然会有轻微位移，
 * 不判位移会导致「每次滚动都弹出菜单」。同时必须屏蔽长按后紧跟的那次 click，
 * 否则菜单会刚弹出就被点击事件关掉。
 */
let pressTimer: number | null = null;
let pressed = false;

const clearPress = () => {
  if (pressTimer !== null) window.clearTimeout(pressTimer);
  pressTimer = null;
};

const onPointerDown = () => {
  pressed = false;
  clearPress();
  pressTimer = window.setTimeout(() => {
    pressed = true;
    emit('longpress', props.song);
  }, 500);
};

const onPointerMove = () => clearPress();

const onClick = () => {
  if (pressed) {
    // 长按已经消费了这次交互
    pressed = false;
    return;
  }
  emit('select', props.song);
};
</script>

<template>
  <div
    class="song-row"
    :class="{ 'is-active': active }"
    :data-song-key="songKey"
    role="button"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="clearPress"
    @pointercancel="clearPress"
    @pointerleave="clearPress"
    @click="onClick"
    @keyup.enter="emit('select', song)"
  >
    <span v-if="showIndex && index >= 0" class="song-index">{{ index + 1 }}</span>

    <div class="song-cover">
      <img v-if="cover" :src="cover" alt="" loading="lazy" />
      <Icon v-else :icon="iconMusic" width="18" height="18" class="cover-fallback" />
    </div>

    <div class="song-meta">
      <div class="song-title-row">
        <!-- 正在播放：三条跳动的音量柱，比单纯变色好认（列表里一眼能找到） -->
        <span v-if="active" class="playing-bars" aria-label="正在播放"><i /><i /><i /></span>
        <p class="song-title ellipsis">{{ song.title || song.name || '未知歌曲' }}</p>
        <span
          v-for="tag in privilegeTags"
          :key="tag.label"
          class="song-tag"
          :style="{ '--tag-color': tag.color }"
          >{{ tag.label }}</span
        >
        <span v-if="qualityTag" class="song-tag is-quality">{{ qualityTag }}</span>
      </div>
      <p class="song-artist ellipsis">{{ artist }}</p>
    </div>

    <span v-if="durationText" class="song-duration">{{ durationText }}</span>
  </div>
</template>

<style scoped>
.song-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 56px;
  padding: var(--sp-2) var(--sp-4);
  /* 长按选中文字会让整页看起来像网页，必须禁掉 */
  user-select: none;
  -webkit-user-select: none;
}

.song-row:active {
  background: var(--fill-subtle);
}

.song-index {
  flex: 0 0 22px;
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.song-cover {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--fill-muted);
}

.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-fallback {
  color: var(--text-tertiary);
}

.song-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.song-title-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  /* 不写 min-width: 0 的话标题的 ellipsis 不生效，长标题会把标签顶出屏幕 */
  min-width: 0;
}

.song-title {
  /*
   * 不 grow：标签要**紧跟歌名文字**，而不是被推到行尾。
   * `flex: 1` 时短歌名右边会空一大片、标签跑到行尾，长歌名才勉强贴上。
   * shrink 保留 + min-width:0：名字过长时让它收让出空间（ellipsis 生效），标签不换行。
   */
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-primary);
}

/* 正在播放的音量柱：纯 CSS 三条，不同高度 + 错开延迟，看起来在跳 */
.playing-bars {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}

.playing-bars i {
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
  transform-origin: bottom;
  animation: playing-bars 0.9s ease-in-out infinite;
}

.playing-bars i:nth-child(1) {
  height: 5px;
  animation-delay: -0.4s;
}

.playing-bars i:nth-child(2) {
  height: 9px;
  animation-delay: -0.2s;
}

.playing-bars i:nth-child(3) {
  height: 6px;
  animation-delay: -0.6s;
}

@keyframes playing-bars {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}

/*
 * 标签只用「描边 + 同色文字」，不填色：
 * 一屏里可能有十几个标签，实心色块会把歌名压下去。
 * 颜色用 CSS 变量从标签数据里带进来（--tag-color: XX）。
 */
.song-tag {
  flex: 0 0 auto;
  padding: 0 3px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 9px;
  line-height: 12px;
  font-weight: var(--weight-semibold);
  color: var(--tag-color, var(--text-tertiary));
  letter-spacing: 0.02em;
}

/* 音质标签固定青色，与特权标签（各自带色）区分开 */
.song-tag.is-quality {
  --tag-color: #06b6d4;
}

/* 正在播放：整行淡绿底 + 歌名变色 + 音量柱，三管齐下（用户要求"一眼看出"） */
.song-row.is-active {
  background: var(--accent-soft);
}

.song-row.is-active .song-title {
  color: var(--accent);
}

.song-row.is-active:active {
  background: var(--accent-soft);
}

.song-artist {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.song-duration {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
</style>
