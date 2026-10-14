<script setup lang="ts">
/**
 * 封面主视觉（封面模式专用）。
 *
 * 只负责那张方形封面本身 —— 背景氛围由播放页统一处理
 * （封面模式用封面模糊、写真模式用写真图，两套机制在播放页里保持一致）。
 *
 * 点击封面会**循环切换视图模式**（封面 → 简约歌词 → 写真）：旧项目没有单独的模式
 * 按钮，点封面是最自然的手势；同时也提供「更多 → 换肤」这个明确入口。
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconMusic } from '@mobile/icons';
import type { Song } from '@/models/song';

const props = defineProps<{
  track: Song | null;
  /** 是否正在播放（封面轻微放大以示状态） */
  playing: boolean;
}>();

const failed = ref(false);
const coverUrl = computed(() => props.track?.coverUrl || props.track?.cover || '');
const showCover = computed(() => Boolean(coverUrl.value) && !failed.value);

watch(coverUrl, () => {
  failed.value = false;
});
</script>

<template>
  <div class="cover-panel">
    <div class="cover-art" :class="{ 'is-playing': playing }">
      <img v-if="showCover" :src="coverUrl" alt="" @error="failed = true" />
      <Icon v-else :icon="iconMusic" width="48" height="48" class="cover-fallback" />
    </div>
  </div>
</template>

<style scoped>
.cover-panel {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4) var(--sp-5) var(--sp-2);
}

.cover-art {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 正方形 + 不超过可用高度：横屏时不会把歌词与底栏顶出去 */
  width: min(58vw, 30dvh);
  aspect-ratio: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--fill-muted);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  transition: transform var(--duration-slow) var(--ease-standard);
}

.cover-art.is-playing {
  transform: scale(1.015);
}

.cover-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-fallback {
  color: var(--text-tertiary);
}
</style>
