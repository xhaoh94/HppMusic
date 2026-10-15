<script setup lang="ts">
/**
 * 底部三栏：主页 · 当前播放（中间封面圆钮）· 我的。
 *
 * 对齐参考产品：中间不是一个普通图标 tab，而是**当前曲目的封面圆钮**，
 * 点开全屏播放页；播放中封面匀速自转（唱片感）。
 *
 * 状态全部来自 `@mobile/adapters/player` —— 不直接读内核 store：
 * 外壳是最早挂载的组件之一，而内核 store 在模块初始化时就摸 window.electron，
 * 经适配层隔离后，这边只需保证它是被动态加载的（见 main.ts 的顺序说明）。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconHome, iconMusic, iconProfile } from '@mobile/icons';
import { useNowPlaying } from '@mobile/adapters/player';
import { getLastHomeSectionPath, suppressNextHomeAutoOpen } from '@mobile/router';
import { useToastStore } from '@/stores/toast';

const route = useRoute();
const router = useRouter();
const toast = useToastStore();

const isHomeSection = computed(() => route.meta.section === 'main');
const isProfile = computed(() => route.path.startsWith('/profile'));

const { hasTrack, isPlaying, coverUrl } = useNowPlaying();

const go = (path: string) => {
  if (route.path === path) return;
  void router.push(path);
};

/**
 * 「主页」按钮。
 *
 * 两条分支，区别在"用户当前在哪"：
 * · 已经在主页分区里 → 回这一栏的根页（发现），与主流 App 的页签行为一致；
 * · 从别的分区（我的、详情页…）回来 → 回到**上次停留的子页签**，
 *   否则用户在「随便听」→「我的」→「主页」之后会被莫名丢回「发现」。
 *
 * ⚠️ 回到「随便听」时不触发"进频道即播"：这条路径是回退而不是进入频道，
 * 不该把播放页顶上来（标记见 router 的 suppressNextHomeAutoOpen）。
 */
const goHomeSection = () => {
  const target = isHomeSection.value ? '/main/home' : getLastHomeSectionPath();
  if (route.path === target) return;
  if (target === '/main/free-listen') suppressNextHomeAutoOpen();
  void router.push(target);
};

/**
 * 打开全屏播放页。
 *
 * 没有曲目时不进去 —— 进去只会看到一个空封面加一排禁用按钮，
 * 不如给一句提示告诉用户"先挑首歌"。
 */
const openNowPlaying = () => {
  if (!hasTrack.value) {
    toast.info('还没有播放内容，先去首页挑一首吧');
    return;
  }
  if (route.name === 'player') return;
  void router.push({ name: 'player' });
};
</script>

<template>
  <nav class="bottom-bar" aria-label="主导航">
    <button
      type="button"
      class="bar-item"
      :class="{ 'is-active': isHomeSection }"
      :aria-current="isHomeSection ? 'page' : undefined"
      @click="goHomeSection"
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
  background: var(--bg-bar);
  /* 不画分隔线：与页面同底色 + 无分界线，三栏和内容才是"连在一起"的观感（用户要求） */
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
  /* 上提 5px（居中时下外边距会把整个盒子往上推一半）：48px 的圆在 56px 的栏里
     贴底边显得局促，抬起来一点更像"浮"着的唱片钮 */
  margin: 0 var(--sp-2) 10px;
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
