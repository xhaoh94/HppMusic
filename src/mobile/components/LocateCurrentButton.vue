<script setup lang="ts">
/**
 * 「定位到正在播放」按钮。
 *
 * 长列表里翻了半天、想回到正在听的那首 —— 没有这个按钮就得自己找
 * （而列表本身可能几十上百首）。有歌曲列表的页面都该有它。
 *
 * ## 只在「当前播放的歌确实在这个列表里」时出现
 *
 * 否则点下去什么都不会发生 —— 那正是本项目一直在避免的"点了没反应的入口"。
 * 判断用的是 `songKeyOf`（与 `SongRow` 写到 DOM 上的键同一套规则）。
 *
 * ## 滚动定位
 *
 * 直接 `scrollIntoView({ block: 'center' })`：让目标行落到视口中间而不是顶部，
 * 上面还能看到几首"上一首"，上下文更完整。用平滑滚动，配合长列表不至于瞬移。
 *
 * 只在**当前可见页面**里找 `[data-song-key]`：被 KeepAlive 缓存的其它页面
 * 其 DOM 已从文档移出，不会误命中。
 */
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { iconTarget } from '@mobile/icons';
import { useNowPlaying } from '@mobile/adapters/player';
import { songKeyOf } from '@mobile/utils/songKey';
import type { Song } from '@/models/song';

const props = withDefaults(
  defineProps<{
    /** 这个列表里的歌，用来判断当前播放的那首在不在其中 */
    songs: readonly Song[];
    /**
     * 距底部的偏移。页面上已有右下角悬浮按钮（如一起听的「＋」）时传大一点，
     * 免得两个圆钮叠在一起。
     */
    bottom?: string;
  }>(),
  { bottom: 'var(--sp-4)' },
);

const { track } = useNowPlaying();

const currentKey = computed(() => songKeyOf(track.value));

/** 当前播放的歌在这个列表里吗？不在就不渲染按钮 */
const present = computed(() => {
  const key = currentKey.value;
  if (!key) return false;
  return props.songs.some((song) => songKeyOf(song) === key);
});

const locate = () => {
  const key = currentKey.value;
  if (!key) return;
  // 键可能是数字/十六进制串，都用 CSS.escape 兜一层，避免选择器语法出错
  const node = document.querySelector(`[data-song-key="${CSS.escape(key)}"]`);
  if (!(node instanceof HTMLElement)) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
};
</script>

<template>
  <button
    v-if="present"
    type="button"
    class="locate-button"
    :style="{ bottom: props.bottom }"
    aria-label="定位到正在播放"
    @click="locate"
  >
    <Icon :icon="iconTarget" width="18" height="18" />
  </button>
</template>

<style scoped>
.locate-button {
  position: absolute;
  right: var(--sp-4);
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--text-secondary);
  /* 半透明底色 + 描边：浮在歌词/封面上时不至于糊成一团 */
  background: var(--bg-overlay);
  border: 1px solid var(--divider-strong);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.locate-button:active {
  transform: scale(0.92);
  color: var(--accent);
}
</style>
