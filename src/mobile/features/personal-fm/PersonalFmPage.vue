<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import SongRow from '@mobile/components/SongRow.vue';
import {
  iconClose,
  iconFavorite,
  iconNext,
  iconPause,
  iconPlay,
  iconRefresh,
} from '@mobile/icons';
import { usePersonalFmAdapter } from '@mobile/adapters/personalFm';
import { songKeyOf } from '@mobile/utils/songKey';
import { useToastStore } from '@/stores/toast';
import type { Song } from '@/models/song';

/** 组件名供 AppShell 的 KeepAlive 匹配。 */
defineOptions({ name: 'PersonalFmPage' });

const router = useRouter();
const toast = useToastStore();
const fm = usePersonalFmAdapter();
const {
  state,
  error,
  isLoggedIn,
  previewTrack,
  displayTracks,
  isPlaying,
  hasFmSession,
  isFavorite,
  load: loadPreview,
  play: playFm,
  togglePlay: toggleFmPlay,
  next: nextFm,
  dislike: dislikeFm,
  toggleFavorite: toggleFmFavorite,
} = fm;
const actionBusy = ref(false);

const hasPreview = computed(() => Boolean(previewTrack.value));
const isLoading = computed(() => state.value === 'loading');
const isError = computed(() => state.value === 'error');

const runAction = async (action: () => Promise<boolean>) => {
  if (actionBusy.value) return;
  actionBusy.value = true;
  try {
    await action();
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : '操作失败，请稍后重试');
  } finally {
    actionBusy.value = false;
  }
};

const load = (force = false) => loadPreview({ force });

const openLogin = () => {
  void router.push({ name: 'login' });
};

const togglePlay = () => runAction(toggleFmPlay);
const next = () => runAction(nextFm);
const dislike = () => runAction(dislikeFm);
const toggleFavorite = () =>
  runAction(async () => {
    const wasFavorite = isFavorite.value;
    const changed = await toggleFmFavorite();
    // toggleFavorite 返回的是“切换后的状态”：取消收藏时为 false，不能只提示收藏成功。
    if (wasFavorite) toast.info('已取消收藏');
    else if (changed) toast.success('已收藏');
    return changed;
  });

const selectTrack = (song: Song) => runAction(() => playFm(song));

const isActive = (song: Song) =>
  hasFmSession.value &&
  songKeyOf(song) === (previewTrack.value ? songKeyOf(previewTrack.value) : '');

onMounted(() => {
  if (isLoggedIn.value) void load();
});
</script>

<template>
  <div class="personal-fm-page">
    <!-- 不放 PageHeader：页面在「主页」分区下，顶部子页签栏已表明位置（同一听页同样处理） -->

    <div class="personal-fm-body scroll-y">
      <EmptyState
        v-if="!isLoggedIn"
        title="登录后收听私人 FM"
        description="登录后才能获得与你的口味匹配的连续推荐"
        action-label="去登录"
        @action="openLogin"
      />

      <EmptyState
        v-else-if="isLoading && !hasPreview"
        tone="loading"
        title="正在准备私人 FM"
        description="正在获取你的专属推荐"
      />

      <EmptyState
        v-else-if="isError"
        tone="error"
        title="私人 FM 加载失败"
        :description="error || '网络开小差了，请稍后重试'"
        action-label="重试"
        @action="load(true)"
      />

      <EmptyState
        v-else-if="!hasPreview"
        title="暂时没有私人 FM 推荐"
        description="稍后再试，或者重新获取一批推荐"
        action-label="重试"
        @action="load(true)"
      />

      <template v-else>
        <section class="fm-hero" aria-labelledby="personal-fm-track-title">
          <div class="hero-cover">
            <img
              v-if="previewTrack?.coverUrl || previewTrack?.cover"
              :src="previewTrack?.coverUrl || previewTrack?.cover"
              alt=""
            />
            <Icon v-else :icon="iconFavorite" width="42" height="42" />
          </div>
          <p class="hero-label">私人 FM · 为你推荐</p>
          <h1 id="personal-fm-track-title" class="hero-title ellipsis">
            {{ previewTrack?.title || previewTrack?.name || '未知歌曲' }}
          </h1>
          <p class="hero-artist ellipsis">{{ previewTrack?.artist || '未知歌手' }}</p>

          <div class="hero-actions" aria-label="私人 FM 播放控制">
            <button
              type="button"
              class="secondary-action"
              :class="{ 'is-favorite': isFavorite }"
              :aria-pressed="isFavorite"
              :disabled="actionBusy"
              :aria-label="isFavorite ? '取消收藏' : '收藏'"
              @click="toggleFavorite"
            >
              <Icon :icon="iconFavorite" width="20" height="20" />
            </button>
            <button
              type="button"
              class="secondary-action"
              :disabled="actionBusy || !hasFmSession"
              aria-label="不喜欢"
              @click="dislike"
            >
              <Icon :icon="iconClose" width="20" height="20" />
            </button>
            <button
              type="button"
              class="primary-action"
              :disabled="actionBusy"
              :aria-label="isPlaying ? '暂停' : '开始'"
              @click="togglePlay"
            >
              <Icon :icon="isPlaying ? iconPause : iconPlay" width="25" height="25" />
              <span>{{ isPlaying ? '暂停' : '开始' }}</span>
            </button>
            <button
              type="button"
              class="secondary-action"
              :disabled="actionBusy || !hasFmSession"
              aria-label="下一首"
              @click="next"
            >
              <Icon :icon="iconNext" width="22" height="22" />
            </button>
          </div>
        </section>

        <section class="recommendations" aria-labelledby="personal-fm-list-title">
          <div class="section-heading">
            <h2 id="personal-fm-list-title">接下来推荐</h2>
            <button
              v-if="!hasFmSession"
              type="button"
              class="refresh-action"
              :disabled="isLoading || actionBusy"
              @click="load(true)"
            >
              <Icon :icon="iconRefresh" width="17" height="17" :class="{ spin: isLoading }" />
              <span>刷新</span>
            </button>
          </div>
          <div class="song-list">
            <SongRow
              v-for="(song, index) in displayTracks"
              :key="`${songKeyOf(song)}-${index}`"
              :song="song"
              :index="index"
              show-index
              :active="isActive(song)"
              @select="selectTrack"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.personal-fm-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.personal-fm-body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--sp-4) var(--sp-6);
}

.fm-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-5) 0 var(--sp-6);
  text-align: center;
}

.hero-cover {
  width: min(62vw, 248px);
  height: min(62vw, 248px);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius-lg);
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 14px 34px rgb(0 0 0 / 16%);
}

.hero-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-label {
  margin: var(--sp-5) 0 var(--sp-1);
  font-size: var(--font-xs);
  color: var(--accent);
}

.hero-title {
  width: 100%;
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.hero-artist {
  max-width: 100%;
  margin: var(--sp-1) 0 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.hero-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
}

.hero-actions button,
.refresh-action {
  border: 0;
  color: var(--text-secondary);
  background: transparent;
}

.hero-actions button:disabled,
.refresh-action:disabled {
  opacity: 0.45;
}

.secondary-action {
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.secondary-action.is-favorite {
  color: var(--accent);
  background: var(--accent-soft);
}

.secondary-action:active,
.refresh-action:active {
  background: var(--fill-subtle);
}

.primary-action {
  min-width: 94px;
  min-height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill) !important;
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
  color: var(--accent-on) !important;
  background: var(--accent) !important;
}

.recommendations {
  padding-bottom: var(--sp-4);
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-1) var(--sp-2);
}

.section-heading h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.refresh-action {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
}

.song-list {
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--fill-subtle);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
