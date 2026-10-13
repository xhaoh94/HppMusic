<script setup lang="ts">
/**
 * 底部三栏：主页 · 当前播放（中间封面圆钮）· 我的。
 *
 * 对齐参考产品：中间不是一个普通图标 tab，而是**当前曲目的封面圆钮**，
 * 点开全屏播放页；播放中封面匀速自转（唱片感）。
 *
 * P0 只接线到「有没有曲目」这一层；P2 接上 player store 的封面/播放态与
 * 全屏播放页的开关。这里刻意不预先 import player store —— 它在模块初始化时
 * 读 window.electron，而外壳是最早挂载的组件之一，早于桥被使用。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconHome, iconMusic, iconProfile } from '@mobile/icons';

const route = useRoute();
const router = useRouter();

const isHomeSection = computed(() => route.meta.section === 'main');
const isProfile = computed(() => route.path.startsWith('/profile'));

/** P2 接 player store；先留出接口形状，避免届时要重排模板。 */
const hasTrack = ref(false);
const isPlaying = ref(false);
const coverUrl = ref('');

const go = (path: string) => {
  if (route.path === path) return;
  void router.push(path);
};

const openNowPlaying = () => {
  // P2: playerStore.toggleLyricView(true)
  if (!hasTrack.value) return;
};
</script>

<template>
  <nav class="bottom-bar" aria-label="主导航">
    <button
      type="button"
      class="bar-item"
      :class="{ 'is-active': isHomeSection }"
      :aria-current="isHomeSection ? 'page' : undefined"
      @click="go('/main/home')"
    >
      <Icon :icon="iconHome" width="24" height="24" />
      <span class="bar-label">主页</span>
    </button>

    <button
      type="button"
      class="now-button"
      :class="{ 'is-playing': isPlaying, 'is-empty': !hasTrack }"
      :aria-label="hasTrack ? '当前播放' : '暂无播放'"
      @click="openNowPlaying"
    >
      <img v-if="coverUrl" class="now-cover" :src="coverUrl" alt="" />
      <Icon v-else :icon="iconMusic" width="22" height="22" />
      <span v-if="isPlaying" class="now-ring" aria-hidden="true" />
    </button>

    <button
      type="button"
      class="bar-item"
      :class="{ 'is-active': isProfile }"
      :aria-current="isProfile ? 'page' : undefined"
      @click="go('/profile')"
    >
      <Icon :icon="iconProfile" width="24" height="24" />
      <span class="bar-label">我的</span>
    </button>
  </nav>
</template>

<style scoped>
.bottom-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  height: calc(var(--bottom-bar-height) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background: var(--bg-raised);
  border-top: 1px solid var(--divider);
}

.bar-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  /* 触屏最小可点区域，低于 48 容易误触 */
  min-width: 48px;
  color: var(--text-tertiary);
  transition: color var(--duration-fast) var(--ease-standard);
}

.bar-item.is-active {
  color: var(--accent);
}

/* 按下反馈：触屏没有 hover，必须给瞬时视觉反馈 */
.bar-item:active {
  background: var(--fill-subtle);
}

.bar-label {
  font-size: var(--font-xs);
  line-height: 1;
}

/* ── 中间的当前播放：封面圆钮 ── */
.now-button {
  position: relative;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  margin: 0 var(--sp-2);
  border-radius: 50%;
  overflow: hidden;
  color: var(--text-tertiary);
  background: var(--fill-muted);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.now-button:active {
  transform: scale(0.94);
}

.now-button.is-empty {
  opacity: 0.55;
}

.now-button.is-playing {
  box-shadow: 0 0 0 2px var(--accent);
}

.now-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 封面是方的、容器是圆的内切圆，任意角度都完整覆盖裁切区，旋转不会露白 */
  animation: now-cover-spin 24s linear infinite;
}

@keyframes now-cover-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 暂停时停下动画（而不是持续转，那样看不出播放状态） */
.now-button:not(.is-playing) .now-cover {
  animation-play-state: paused;
}
</style>
