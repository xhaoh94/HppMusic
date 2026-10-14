<script setup lang="ts">
/**
 * 「更多」面板：定时关闭 + 播放倍速。
 *
 * ## 定时关闭只有「暂停播放」一种动作
 *
 * 内核的 `sleepTimer.start(minutes, action)` 支持 `pause` / `quit` / `shutdown`，
 * 但后两个走的是 `window.electron.power.executeSleepTimerAction` —— 那是桌面主进程
 * 的能力（退出应用 / 关机），Android 桥没有实现，选了会直接弹
 * 「请重启 EchoMusic 后使用退出或关机动作」。所以这里只提供 `pause`：
 * 对手机来说"到点暂停"也正是唯一有意义的行为（定时关机该交给系统）。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{
  modelValue: boolean;
  /** 当前视图模式（与播放页共享同一份 settingStore.lyricViewMode） */
  skin?: 'cover' | 'lyric' | 'portrait';
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:skin': [value: 'cover' | 'lyric' | 'portrait'];
}>();

/** 「换肤」可选项（对齐旧项目菜单里那一项的名字） */
const SKIN_OPTIONS = [
  { value: 'cover' as const, label: '封面' },
  { value: 'lyric' as const, label: '简约歌词' },
  { value: 'portrait' as const, label: '写真' },
];

const pickSkin = (value: 'cover' | 'lyric' | 'portrait') => {
  emit('update:skin', value);
  // 选完不关菜单：用户可能想连着试几种看效果
};

const player = usePlayerStore();
const toast = useToastStore();
const router = useRouter();

/** MV 挂在歌曲下，用 albumAudioId 定位；没有它就没法查 MV */
const albumAudioId = computed(() => String(player.currentTrackSnapshot?.albumAudioId ?? ''));

const openMv = () => {
  if (!albumAudioId.value) {
    toast.warning('当前曲目缺少 MV 标识，无法查找');
    return;
  }
  emit('update:modelValue', false);
  void router.push({ name: 'mv', params: { id: albumAudioId.value } });
};

const TIMER_OPTIONS = [5, 15, 30, 60, 90];
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const selectingMinutes = ref<number | null>(null);

const timerActive = computed(() => Boolean(player.sleepTimer?.deadline));
const remainingText = computed(() => {
  if (!timerActive.value) return '';
  const seconds = Math.max(0, Math.round(Number(player.sleepTimer?.remainingSeconds ?? 0)));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `剩余 ${minutes} 分钟` : `剩余 ${seconds} 秒`;
});

const currentSpeed = computed(() => Number(player.playbackRate ?? 1));

const startTimer = (minutes: number) => {
  // 动作固定 pause —— 理由见文件头
  const started = player.startSleepTimer(minutes, 'pause');
  if (!started) {
    toast.danger('定时开启失败，请稍后重试');
    return;
  }
  toast.success(`${minutes} 分钟后暂停播放`);
  selectingMinutes.value = minutes;
};

const cancelTimer = () => {
  player.cancelSleepTimer();
  selectingMinutes.value = null;
  toast.info('已取消定时暂停');
};

const setSpeed = (speed: number) => {
  player.setPlaybackRate(speed);
  toast.info(speed === 1 ? '已恢复原速' : `已切换到 ${speed}×`);
};
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="更多"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <section class="block">
      <header class="block-head">
        <h3 class="block-title">定时暂停</h3>
        <span v-if="timerActive" class="block-status">{{ remainingText }}</span>
      </header>
      <div class="chips">
        <button
          v-for="minutes in TIMER_OPTIONS"
          :key="minutes"
          type="button"
          class="chip"
          :class="{ 'is-active': timerActive && player.sleepTimer?.durationMinutes === minutes }"
          @click="startTimer(minutes)"
        >
          {{ minutes }} 分钟
        </button>
      </div>
      <button v-if="timerActive" type="button" class="cancel" @click="cancelTimer">
        取消定时
      </button>
    </section>

    <section class="block">
      <header class="block-head">
        <h3 class="block-title">播放速度</h3>
        <span v-if="currentSpeed !== 1" class="block-status">{{ currentSpeed }}×</span>
      </header>
      <div class="chips">
        <button
          v-for="speed in SPEED_OPTIONS"
          :key="speed"
          type="button"
          class="chip"
          :class="{ 'is-active': currentSpeed === speed }"
          @click="setSpeed(speed)"
        >
          {{ speed }}×
        </button>
      </div>
    </section>

    <!-- 换肤：旧项目把视图模式放在这个菜单里（而不是播放页上的单独按钮） -->
    <section class="block">
      <header class="block-head">
        <h3 class="block-title">换肤</h3>
      </header>
      <div class="chips">
        <button
          v-for="option in SKIN_OPTIONS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ 'is-active': props.skin === option.value }"
          @click="pickSkin(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <!-- MV 入口：上游的 MV 挂在歌曲下（/kmr/audio/mv?album_audio_id=），
         所以带上当前曲目的 albumAudioId，由 MV 页自己查有没有、再取地址 -->
    <section class="block">
      <header class="block-head">
        <h3 class="block-title">视频</h3>
      </header>
      <button
        type="button"
        class="action-item"
        :disabled="!albumAudioId"
        @click="openMv"
      >
        <span class="action-label">查看 MV</span>
        <span class="action-note">{{ albumAudioId ? '同一首歌的官方 MV' : '当前曲目没有 MV 标识' }}</span>
      </button>
    </section>
  </Sheet>
</template>

<style scoped>
.block + .block {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--divider);
}

.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}

.block-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
}

.block-status {
  font-size: var(--font-xs);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.chip {
  min-height: 38px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
  border: 1px solid transparent;
}

.chip.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: var(--weight-semibold);
}

.cancel {
  width: 100%;
  min-height: 44px;
  margin-top: var(--sp-3);
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--fill-subtle);
}

/* MV 入口行 */
.action-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-height: 52px;
  padding: var(--sp-2) 0;
  text-align: left;
}

.action-item:active:not(:disabled) {
  background: var(--fill-subtle);
}

.action-item:disabled {
  opacity: 0.45;
}

.action-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.action-note {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}
</style>
