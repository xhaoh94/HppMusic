<script setup lang="ts">
/**
 * 写真模式。
 *
 * 歌手写真轮播铺满背景，歌词浮在上面 —— 旧项目里这是"沉浸"最强的一档。
 *
 * 移动端与桌面端的三处差异（都是有意的）：
 * 1. **不做手动上一张/下一张**：写真本身有自动轮播，触屏上再加一对按钮只是噪声。
 *    （前身项目在移动端补丁里也明确删掉了这两个控件。）
 * 2. **不做自动收起歌词**：桌面端写真页会定时把歌词收成"当前行+下一行"的窄条，
 *    好让写真露出更多；但桌面一晃鼠标就能展开，触屏没有这个动作，收了就收不回来。
 * 3. **没有写真时退回封面**：宁可显示专辑封面，也不要一整块纯色。
 */
import { computed } from 'vue';
import type { Song } from '@/models/song';
import LyricsPanel from './LyricsPanel.vue';

const props = defineProps<{
  track: Song | null;
  /** 平滑播放位置（毫秒），透传给歌词面板做逐字高亮 */
  positionMs: number;
  /** 本面板是否为当前可见页（不可见时停掉歌词的自动跟随） */
  active: boolean;
  /** 轮播图片地址；为空时回退到封面 */
  portraitUrl: string;
  /** 轮播索引，用于 key 触发过渡 */
  portraitIndex: number;
}>();

const backdropUrl = computed(
  () => props.portraitUrl || props.track?.coverUrl || props.track?.cover || '',
);
const singer = computed(() => props.track?.artist || '');
</script>

<template>
  <div class="portrait-panel">
    <Transition name="portrait-fade" mode="out-in">
      <img
        v-if="backdropUrl"
        :key="portraitIndex"
        class="portrait-image"
        :src="backdropUrl"
        alt=""
        aria-hidden="true"
      />
    </Transition>
    <div class="portrait-veil" aria-hidden="true" />

    <div class="portrait-content">
      <LyricsPanel :position-ms="positionMs" :active="active" />
      <p v-if="singer" class="portrait-singer">{{ singer }}</p>
    </div>
  </div>
</template>

<style scoped>
.portrait-panel {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.portrait-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 缓慢放大：静态写真也能"活着"。位移很小，避免眩晕。 */
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

/* 上下压暗：中间留给写真，两端保证歌词可读 */
.portrait-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.55) 0%,
    rgba(0, 0, 0, 0.2) 30%,
    rgba(0, 0, 0, 0.45) 70%,
    rgba(0, 0, 0, 0.7) 100%
  );
}

.portrait-content {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.portrait-singer {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 var(--sp-5) var(--sp-4);
  text-align: center;
  font-size: var(--font-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.18em;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
}

/* 歌词在写真上要更亮：底色是任意图片，默认的次要色会看不清 */
.portrait-content :deep(.line) {
  color: rgba(255, 255, 255, 0.5);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55);
}

.portrait-content :deep(.line.is-near) {
  color: rgba(255, 255, 255, 0.72);
}

.portrait-content :deep(.line.is-active) {
  color: #fff;
}

.portrait-content :deep(.line-sub) {
  color: rgba(255, 255, 255, 0.6);
}

/* 写真边缘也不该出现硬边 */
.portrait-content :deep(.lyrics) {
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 16%,
    black 84%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 16%,
    black 84%,
    transparent 100%
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
</style>
