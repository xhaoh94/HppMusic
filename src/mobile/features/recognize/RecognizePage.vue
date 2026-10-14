<script setup lang="ts">
/**
 * 听歌识曲。
 *
 * 交互（对齐上游）：一个圆钮开始录 → 录最多 10 秒（也可手动停）→ 上传识别 → 结果列表。
 *
 * 三件必须做对的事：
 * 1. **离开页面一定要释放麦克风** —— 否则录音会一直开着，麦克风被占用、还耗电，
 *    用户下次进别的应用录音会发现"设备被占用"。`onBeforeUnmount` 里强制 dispose。
 * 2. **录音中禁止返回**（或在返回时先取消）：直接退出会留下一个后台录音的进程。
 *    这里在注册返回键处理器时优先取消录音。
 * 3. **识别结果可点播** —— 识别出来却不能听是最没意义的结果页。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import SongRow from '@mobile/components/SongRow.vue';
import { iconMicrophone, iconSpinner } from '@mobile/icons';
import { useRecognize, MAX_RECORD_SECONDS } from '@mobile/adapters/recognize';
import { usePlaybackActions } from '@mobile/adapters/player';
import { pushBackHandler } from '@bridge/backButton';
import type { RecognizeMatch } from '@/utils/mappers';
import type { Song } from '@/models/song';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';

const router = useRouter();
const { playSong } = usePlaybackActions();
const { status, seconds, matches, error, start, stop, cancel, reset, dispose } = useRecognize();

const QUEUE_META = { queueId: 'queue:recognize', title: '听歌识曲', subtitle: '' };

/** 结果的播放上下文（只有识别出的这几首） */
const matchedSongs = computed(() => matches.value.map((match) => match.song));

/** 录音进度 0~1，用于圆钮外圈的进度弧 */
const progress = computed(() => Math.min(1, seconds.value / MAX_RECORD_SECONDS));

const hint = computed(() => {
  if (status.value === 'recording') return `${seconds.value}s / ${MAX_RECORD_SECONDS}s · 点击停止`;
  if (status.value === 'recognizing') return '正在识别…';
  if (status.value === 'done') return matches.value.length ? '选择要播放的歌曲' : '';
  if (status.value === 'failed') return '';
  return '点击开始，让手机听一下';
});

const onButton = () => {
  if (status.value === 'recording') {
    void stop();
    return;
  }
  if (status.value === 'recognizing') return;
  if (status.value === 'done' || status.value === 'failed') reset();
  void start();
};

const onSelect = async (song: Song) => {
  await playSong(song, matchedSongs.value, QUEUE_META);
};

onMounted(() => {
  // 录音中按返回键先取消录音，而不是直接离开（否则会留下后台录音）
  const off = pushBackHandler(() => {
    if (status.value !== 'recording' && status.value !== 'recognizing') return false;
    cancel();
    return true;
  });
  onBeforeUnmount(() => {
    off();
    dispose();
  });
});
/** 给「定位到当前播放」用：识别结果是 { song, confidence } 包装 */
const locateSongs = computed(() => matches.value.map((match) => match.song));
</script>

<template>
  <div class="recognize-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="locateSongs" />
    <PageHeader title="听歌识曲">
      <template #actions>
        <button
          v-if="status === 'done' || status === 'failed'"
          type="button"
          class="header-action"
          @click="reset"
        >
          重新识别
        </button>
      </template>
    </PageHeader>

    <div class="page-body scroll-y">
      <section class="stage">
        <button
          type="button"
          class="mic-button"
          :class="[`is-${status}`]"
          :aria-label="status === 'recording' ? '停止识别' : '开始识别'"
          :disabled="status === 'recognizing'"
          @click="onButton"
        >
          <!-- 录音时的脉冲圈：给"正在听"一个明确的视觉信号 -->
          <span v-if="status === 'recording'" class="pulse-ring" aria-hidden="true" />
          <span v-if="status === 'recording'" class="pulse-ring is-delayed" aria-hidden="true" />
          <Icon
            v-if="status === 'recognizing'"
            :icon="iconSpinner"
            width="34"
            height="34"
            class="spin"
          />
          <Icon v-else :icon="iconMicrophone" width="34" height="34" />
          <span
            v-if="status === 'recording'"
            class="progress-arc"
            :style="{ '--p': progress }"
            aria-hidden="true"
          />
        </button>

        <p class="hint">{{ hint }}</p>
        <p v-if="status === 'idle'" class="sub-hint">
          请在安静环境下让手机靠近音源；Android 只能使用麦克风（无系统内录）
        </p>
      </section>

      <EmptyState
        v-if="status === 'failed'"
        tone="error"
        title="识别失败"
        :description="error"
        action-label="再试一次"
        @action="reset"
      />

      <EmptyState
        v-else-if="status === 'done' && !matches.length"
        title="没有识别到歌曲"
        :description="error || '换个环境、把手机靠近音源再试试'"
        action-label="再试一次"
        @action="reset"
      />

      <template v-else-if="matches.length">
        <div class="results">
          <div v-for="match in matches" :key="String(match.song.id)" class="result-row">
            <!-- 相似度：上游把 dist 距离换算成了 0~1 的置信度，显示出来用户能判断准不准 -->
            <p class="confidence">匹配度 {{ Math.round(match.confidence * 100) }}%</p>
            <SongRow :song="match.song" @select="onSelect" />
          </div>
        </div>
        <p class="results-note">识别结果来自酷狗曲库，点击即可播放</p>
      </template>

      <EmptyState
        v-else-if="status === 'idle'"
        title="还没有识别记录"
        description="听到喜欢的歌却不知道名字？点上面的按钮试试"
      />
    </div>
  </div>
</template>

<style scoped>
.recognize-page {
  /* 定位按钮的绝对定位参照 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  min-height: 34px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

/* ── 录音按钮 ── */
.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-6) var(--sp-5) var(--sp-4);
}

.mic-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 128px;
  height: 128px;
  border-radius: 50%;
  color: var(--accent-on);
  background: var(--accent);
  transition:
    transform var(--duration-normal) var(--ease-standard),
    background var(--duration-normal) var(--ease-standard);
}

.mic-button:active:not(:disabled) {
  transform: scale(0.95);
}

.mic-button.is-recording {
  background: var(--danger);
}

.mic-button.is-recognizing {
  opacity: 0.8;
}

/* 脉冲圈 */
.pulse-ring {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--danger);
  animation: pulse-out 1.8s var(--ease-standard) infinite;
}

.pulse-ring.is-delayed {
  animation-delay: 0.9s;
}

@keyframes pulse-out {
  0% {
    transform: scale(0.9);
    opacity: 0.7;
  }
  100% {
    transform: scale(1.35);
    opacity: 0;
  }
}

/* 录音进度弧：用 conic-gradient 画外圈，--p 是 0~1 的进度 */
.progress-arc {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: conic-gradient(
    #fff calc(var(--p, 0) * 360deg),
    rgba(255, 255, 255, 0.25) 0
  );
  /* 只留外圈：中间用一层实心圆遮住 */
  mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
  pointer-events: none;
}

.hint {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-primary);
  text-align: center;
}

.sub-hint {
  margin: 0;
  max-width: 300px;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
  text-align: center;
}

.results {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--sp-2);
}

.result-row + .result-row {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--divider);
}

.confidence {
  margin: 0;
  padding: 0 var(--sp-4) var(--sp-1);
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.results-note {
  margin: 0;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
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
