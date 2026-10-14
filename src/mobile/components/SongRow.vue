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
      <p class="song-title ellipsis">{{ song.title || song.name || '未知歌曲' }}</p>
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

.song-title {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-primary);
}

.song-row.is-active .song-title {
  color: var(--accent);
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
