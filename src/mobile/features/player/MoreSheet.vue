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
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const player = usePlayerStore();
const toast = useToastStore();

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
</style>
