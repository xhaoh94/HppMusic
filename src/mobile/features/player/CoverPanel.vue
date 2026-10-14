<script setup lang="ts">
/**
 * 封面模式。
 *
 * 与"简约歌词"的区别只是**主视觉是封面**：歌词照常显示在下方（旧项目的封面模式
 * 也是这样 —— 它不是一个纯图片页，底部仍然有当前行歌词）。
 *
 * 氛围感来自"封面放大模糊铺满背景"，而不是额外下载一张背景图：
 * 同一张图放大到 40px 再模糊，几乎不额外占内存，也没有网络请求。
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconMusic } from '@mobile/icons';
import type { Song } from '@/models/song';

const props = defineProps<{
  track: Song | null;
  /** 当前曲目的当前行歌词，显示在封面下方 */
  currentLine: string;
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
    <!-- 背景：同一张封面放大模糊。用 img 而不是 background-image，
         这样加载失败的回退逻辑与主封面一致。 -->
    <img
      v-if="showCover"
      class="cover-backdrop"
      :src="coverUrl"
      alt=""
      aria-hidden="true"
      @error="failed = true"
    />
    <div class="cover-backdrop-veil" aria-hidden="true" />

    <div class="cover-stage">
      <div class="cover-art" :class="{ 'is-playing': playing }">
        <img v-if="showCover" :src="coverUrl" alt="" @error="failed = true" />
        <Icon v-else :icon="iconMusic" width="48" height="48" class="cover-fallback" />
      </div>

      <p v-if="currentLine" class="cover-line">{{ currentLine }}</p>
    </div>
  </div>
</template>

<style scoped>
.cover-panel {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.cover-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 大幅模糊 + 压暗：只留色彩氛围，不抢主封面 */
  filter: blur(48px) saturate(1.4);
  transform: scale(1.25);
  opacity: 0.55;
}

.cover-backdrop-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0.55));
}

.cover-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-4);
  width: 100%;
}

.cover-art {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 正方形 + 不超过可用高度：横屏时不会把歌词顶出去 */
  width: min(72vw, 42dvh);
  aspect-ratio: 1;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--fill-muted);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  transition: transform var(--duration-slow) var(--ease-standard);
}

.cover-art.is-playing {
  transform: scale(1.02);
}

.cover-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-fallback {
  color: var(--text-tertiary);
}

.cover-line {
  margin: 0;
  max-width: 88%;
  text-align: center;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  line-height: 1.5;
  color: #fff;
  /* 背景是任意封面图，必须靠阴影保证可读性 */
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
  /* 歌词切换不要有跳动感 */
  min-height: 1.5em;
}
</style>
