<script setup lang="ts">
/**
 * MV 播放页。
 *
 * ## 为什么路由参数是 albumAudioId 而不是 hash
 *
 * 上游的 MV 是**挂在歌曲下面**的：`/kmr/audio/mv?album_audio_id=...` 才能查到
 * 这首歌有哪些 MV。所以入口（播放页「更多」→ 查看 MV）只需要带上当前曲目的
 * albumAudioId，由本页自己完成「查 MV 列表 → 取视频地址」两步，
 * 而不是让入口先去查一遍再把 hash 传进来。
 *
 * ## 视频地址的两步获取
 *
 * 1. `/kmr/audio/mv` → 返回**嵌套数组** `data: [[{...}]]`，
 *    用内核的 `mapVideoMetaList` 解析（它内部已经处理了这个嵌套）。
 * 2. `/video/url?hash=` → `data[hash] = { downurl, backupdownurl }`，
 *    用内核的 `extractVideoUrl(payload, hash)` 取地址。
 *
 * ## 与「音频播放」的关系
 *
 * MV 用的是 HTML5 `<video>`，和内核的音频引擎是两套东西。
 * 进入本页时**不打断音频播放**（用户可能就想看看 MV 封面），
 * 但如果 MV 开始出声，用户多半不想同时听两路 —— 所以这里在视频真正开始播放时
 * 暂停音频播放器。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { getSongMv, getVideoUrl } from '@/api/video';
import { extractVideoUrl } from '@/utils/mappers/video';
import { listMvEntries, type MvEntry } from '@mobile/adapters/mv';
import { usePlayerStore } from '@/stores/player';
import logger from '@/utils/logger';
import { iconMusic } from '@mobile/icons';

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();

const albumAudioId = computed(() => String(route.params.id ?? ''));

type LoadState = 'loading' | 'ready' | 'no-mv' | 'error';

const state = ref<LoadState>('loading');
const failureText = ref('');
const video = ref<MvEntry | null>(null);
const videoUrl = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);

const load = async () => {
  state.value = 'loading';
  failureText.value = '';
  videoUrl.value = '';
  try {
    const mvResponse = await getSongMv(albumAudioId.value);
    const list = listMvEntries(mvResponse);
    if (!list.length) {
      state.value = 'no-mv';
      return;
    }
    // 同一首歌可能有多个 MV（不同版本），取第一个 —— 与上游的默认行为一致
    const target = list[0];
    video.value = target;

    const urlResponse = await getVideoUrl(target.hash);
    const url = extractVideoUrl(urlResponse, target.hash);
    if (!url) throw new Error('没有拿到视频地址（可能没有播放权限）');
    videoUrl.value = url;
    state.value = 'ready';
  } catch (error) {
    logger.warn('Mv', 'Load MV failed', error);
    failureText.value = error instanceof Error ? error.message : String(error);
    state.value = 'error';
  }
};

/** 视频开始出声时暂停音频播放器，避免两路声音叠在一起 */
const onVideoPlaying = () => {
  if (player.isPlaying) void player.togglePlay();
};

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  // 明确停止视频：Android WebView 里离开页面但 video 元素仍被引用时可能继续播
  const element = videoEl.value;
  if (element) {
    element.pause();
    element.removeAttribute('src');
    element.load();
  }
});

const title = computed(() => video.value?.title || 'MV');
const cover = computed(() => video.value?.cover || '');
</script>

<template>
  <div class="mv-page">
    <PageHeader :title="title" />

    <div class="page-body">
      <EmptyState v-if="state === 'loading'" tone="loading" title="正在加载 MV" />
      <EmptyState
        v-else-if="state === 'no-mv'"
        title="这首歌没有 MV"
        description="可以回到播放页继续听歌"
        action-label="返回"
        @action="router.back()"
      />
      <EmptyState
        v-else-if="state === 'error'"
        tone="error"
        title="MV 加载失败"
        :description="failureText"
        action-label="重试"
        @action="load"
      />

      <div v-else class="player">
        <video
          ref="videoEl"
          class="video"
          :src="videoUrl"
          :poster="cover"
          controls
          autoplay
          playsinline
          @playing="onVideoPlaying"
        />
        <div class="meta">
          <p class="meta-title ellipsis">{{ title }}</p>
          <p class="meta-artist">
            <span v-if="video?.artist" class="ellipsis">{{ video.artist }}</span>
            <span v-if="video?.quality" class="quality">{{ video.quality }}</span>
          </p>
        </div>
      </div>

      <div v-if="state === 'loading'" class="skeleton">
        <Icon :icon="iconMusic" width="40" height="40" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mv-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #000;
}

.page-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.player {
  display: flex;
  flex-direction: column;
}

.video {
  width: 100%;
  /* MV 大多是 16:9；给一个上限避免竖屏下被拉得过高 */
  max-height: 60dvh;
  background: #000;
}

.meta {
  padding: var(--sp-3) var(--sp-4);
}

.meta-title {
  margin: 0 0 2px;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: #fff;
}

.meta-artist {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--font-sm);
  color: rgba(255, 255, 255, 0.6);
}

.quality {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-size: 10px;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.14);
}

.skeleton {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: rgba(255, 255, 255, 0.2);
}
</style>
