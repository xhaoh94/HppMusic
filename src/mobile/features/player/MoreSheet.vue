<script setup lang="ts">
/**
 * 「更多」面板。
 *
 * ## 版式对齐旧项目：一行一个功能
 *
 * 旧项目这个菜单是**单列列表**（图标 + 文字 + 齿轮），不是分区 + chips。我原来是
 * 分区式，虽然少点一次，但和参考产品差得远。现在改成行列表：每行左侧图标、
 * 中间标题、右侧当前值/箭头；需要选值的行（定时/倍速/换肤）**内联展开** chips，
 * 不弹二级面板 —— 手机上少一层浮层更好用，"在哪里展开、展开的是什么"也更清楚。
 *
 * ## 定时关闭只有「暂停播放」一种动作
 *
 * 内核 `sleepTimer.start(minutes, action)` 支持 `pause` / `quit` / `shutdown`，
 * 后两个走 `window.electron.power.executeSleepTimerAction` —— 那是桌面主进程的能力
 * （退出应用 / 关机），Android 桥没有实现，选了会提示「请重启 EchoMusic 后使用」。
 * 所以这里只提供 `pause`：对手机来说"到点暂停"也正是唯一有意义的行为。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import { createSongShareTarget } from '@/utils/share';
import { buildShareText } from '@shared/share';
import { copyShareText, sendShareText } from '@bridge/shareApi';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';
import {
  iconMoon,
  iconPlaylistAdd,
  iconShare,
  iconShirt,
  iconSlidersHorizontal,
  iconSpeed,
  iconVideo,
} from '@mobile/icons';

export type PlayerSkin = 'cover' | 'lyric' | 'portrait';

const props = defineProps<{
  modelValue: boolean;
  /** 当前视图模式（与播放页共享同一份 settingStore.lyricViewMode） */
  skin?: PlayerSkin;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:skin': [value: PlayerSkin];
  /** 音效面板由播放页承载（本组件不自己再开一层 Sheet，否则两层遮罩会叠） */
  'open-effect': [];
  'open-add-to-playlist': [];
}>();

const player = usePlayerStore();
const toast = useToastStore();
const router = useRouter();

const close = () => emit('update:modelValue', false);

/** 当前展开的行（同时只能展开一行，避免面板被撑得过长） */
const expanded = ref<'timer' | 'speed' | 'skin' | null>(null);
const toggleExpand = (key: 'timer' | 'speed' | 'skin') => {
  expanded.value = expanded.value === key ? null : key;
};

/* ── 定时暂停 ── */
const TIMER_OPTIONS = [5, 15, 30, 60, 90];
const timerActive = computed(() => Boolean(player.sleepTimer?.deadline));
const timerLabel = computed(() => {
  if (!timerActive.value) return '未开启';
  const seconds = Math.max(0, Math.round(Number(player.sleepTimer?.remainingSeconds ?? 0)));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `剩余 ${minutes} 分钟` : `剩余 ${seconds} 秒`;
});

const startTimer = (minutes: number) => {
  // 动作固定 pause —— 理由见文件头
  if (!player.startSleepTimer(minutes, 'pause')) {
    toast.danger('定时开启失败，请稍后重试');
    return;
  }
  toast.success(`${minutes} 分钟后暂停播放`);
  expanded.value = null;
};

const cancelTimer = () => {
  player.cancelSleepTimer();
  toast.info('已取消定时暂停');
};

/* ── 倍速 ── */
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const currentSpeed = computed(() => Number(player.playbackRate ?? 1));
const speedLabel = computed(() => (currentSpeed.value === 1 ? '1×' : `${currentSpeed.value}×`));

const setSpeed = (speed: number) => {
  player.setPlaybackRate(speed);
  toast.info(speed === 1 ? '已恢复原速' : `已切换到 ${speed}×`);
  expanded.value = null;
};

/* ── 换肤 ── */
const SKIN_OPTIONS: { value: PlayerSkin; label: string }[] = [
  { value: 'cover', label: '封面' },
  { value: 'lyric', label: '简约歌词' },
  { value: 'portrait', label: '写真' },
];
const skinLabel = computed(
  () => SKIN_OPTIONS.find((item) => item.value === props.skin)?.label ?? '封面',
);
const pickSkin = (value: PlayerSkin) => {
  emit('update:skin', value);
  // 选完不关菜单：用户可能想连着试几种看效果
};

/* ── 播放 MV ── */
const albumAudioId = computed(() => String(player.currentTrackSnapshot?.albumAudioId ?? ''));
const openMv = () => {
  if (!albumAudioId.value) {
    toast.warning('当前曲目缺少 MV 标识，无法查找');
    return;
  }
  close();
  void router.push({ name: 'mv', params: { id: albumAudioId.value } });
};

/* ── 分享 ── */
/**
 * 分享当前曲目。
 *
 * 优先走**原生分享面板**（`EchoShare.share`，Android 的 chooser），它比"复制链接"
 * 更符合手机上的分享预期；原生不可用或用户取消时回落到复制链接 —— 旧项目只有复制
 * 这一条路，移动端有原生能力就没必要退化。
 *
 * 文案用内核的 `buildShareText`（含曲名与 web 链接），但 `sharer` 覆盖成 HppMusic：
 * 内核对未登录用户的默认值写的是桌面品牌名。
 */
const sharing = ref(false);
const shareCurrent = async () => {
  const song = player.currentTrackSnapshot as Song | null;
  if (!song) {
    toast.warning('还没有正在播放的歌曲');
    return;
  }
  const target = createSongShareTarget(song);
  if (!target) {
    toast.warning('这首歌缺少分享标识，无法生成链接');
    return;
  }
  const text = buildShareText({ ...target, sharer: 'HppMusic' });
  sharing.value = true;
  try {
    if (await sendShareText(text)) {
      close();
      return;
    }
    // 原生面板没起来（例如系统里没有可接收的应用）→ 复制兜底，用户至少拿到链接
    if (await copyShareText(text)) toast.success('分享链接已复制');
    else toast.danger('分享失败，请稍后重试');
  } catch (error) {
    logger.warn('MoreSheet', 'Share failed', error);
    toast.danger('分享失败，请稍后重试');
  } finally {
    sharing.value = false;
  }
};
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="更多功能"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="rows">
      <!-- 音效 -->
      <button type="button" class="row" @click="emit('open-effect')">
        <Icon :icon="iconSlidersHorizontal" width="20" height="20" class="row-icon" />
        <span class="row-label">音效</span>
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>

      <!-- 定时暂停 -->
      <button type="button" class="row" @click="toggleExpand('timer')">
        <Icon :icon="iconMoon" width="20" height="20" class="row-icon" />
        <span class="row-label">定时关闭</span>
        <span class="row-value" :class="{ 'is-on': timerActive }">{{ timerLabel }}</span>
        <span class="row-chevron" :class="{ 'is-open': expanded === 'timer' }" aria-hidden="true">›</span>
      </button>
      <div v-if="expanded === 'timer'" class="expander">
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
        <button v-if="timerActive" type="button" class="expander-cancel" @click="cancelTimer">
          取消定时
        </button>
      </div>

      <!-- 倍速 -->
      <button type="button" class="row" @click="toggleExpand('speed')">
        <Icon :icon="iconSpeed" width="20" height="20" class="row-icon" />
        <span class="row-label">倍速</span>
        <span class="row-value">{{ speedLabel }}</span>
        <span class="row-chevron" :class="{ 'is-open': expanded === 'speed' }" aria-hidden="true">›</span>
      </button>
      <div v-if="expanded === 'speed'" class="expander">
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
      </div>

      <!-- 添加到歌单 -->
      <button type="button" class="row" @click="emit('open-add-to-playlist')">
        <Icon :icon="iconPlaylistAdd" width="20" height="20" class="row-icon" />
        <span class="row-label">添加到</span>
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>

      <!-- 播放 MV -->
      <button type="button" class="row" :disabled="!albumAudioId" @click="openMv">
        <Icon :icon="iconVideo" width="20" height="20" class="row-icon" />
        <span class="row-label">播放 MV</span>
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>

      <!-- 换肤 -->
      <button type="button" class="row" @click="toggleExpand('skin')">
        <Icon :icon="iconShirt" width="20" height="20" class="row-icon" />
        <span class="row-label">换肤</span>
        <span class="row-value">{{ skinLabel }}</span>
        <span class="row-chevron" :class="{ 'is-open': expanded === 'skin' }" aria-hidden="true">›</span>
      </button>
      <div v-if="expanded === 'skin'" class="expander">
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
      </div>

      <!-- 分享 -->
      <button type="button" class="row" :disabled="sharing" @click="shareCurrent">
        <Icon :icon="iconShare" width="20" height="20" class="row-icon" />
        <span class="row-label">分享</span>
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>
    </div>
  </Sheet>
</template>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.row:active:not(:disabled) {
  background: var(--fill-subtle);
}

.row:disabled {
  opacity: 0.4;
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.row-label {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
  color: var(--text-primary);
}

.row-value {
  flex: 0 0 auto;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.row-value.is-on {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* 展开指示：收起时朝右，展开时转 90° 朝下 */
.row-chevron {
  flex: 0 0 auto;
  font-size: 20px;
  line-height: 1;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.row-chevron.is-open {
  transform: rotate(90deg);
}

.expander {
  padding: var(--sp-1) var(--sp-2) var(--sp-4) 40px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.chip {
  min-height: 36px;
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

.expander-cancel {
  width: 100%;
  min-height: 40px;
  margin-top: var(--sp-2);
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  color: var(--danger);
  background: var(--fill-subtle);
}
</style>
