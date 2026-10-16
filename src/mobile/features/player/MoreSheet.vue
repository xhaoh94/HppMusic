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
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import {
  iconBarrage,
  iconMoon,
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
}>();

const player = usePlayerStore();
const setting = useSettingStore();
const toast = useToastStore();
const router = useRouter();

const close = () => emit('update:modelValue', false);

/** 当前展开的行（同时只能展开一行，避免面板被撑得过长） */
const expanded = ref<'timer' | 'speed' | 'skin' | 'barrage' | null>(null);
const toggleExpand = (key: 'timer' | 'speed' | 'skin' | 'barrage') => {
  expanded.value = expanded.value === key ? null : key;
};

/* ── 弹幕 ── */
/**
 * 开关直接写内核的 `lyricBarrageEnabled`（桌面端同一个键），弹幕层监听它。
 * 外观设置写 `lyricBarrageConfig` —— 它本来就是给“歌词页弹幕”用的那一份，
 * 移动端全屏播放页就是桌面端说的歌词页，语义对得上，不另开一份配置。
 */
const barrageEnabled = computed({
  get: () => Boolean(setting.lyricBarrageEnabled),
  set: (value: boolean) => {
    setting.lyricBarrageEnabled = value;
  },
});

const barrageConfig = computed(() => setting.lyricBarrageConfig);
const BARRAGE_FONT_SIZES = [14, 17, 20];
const BARRAGE_SPEEDS = [0.5, 1, 1.5, 2];
const BARRAGE_OPACITY = [50, 75, 100];
const BARRAGE_DENSITY: { value: number; label: string }[] = [
  { value: 1, label: '稀疏' },
  { value: 2, label: '正常' },
  { value: 3, label: '密集' },
];

const setBarrageConfig = (patch: Partial<typeof barrageConfig.value>) => {
  setting.lyricBarrageConfig = { ...barrageConfig.value, ...patch };
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

      <!--
        「添加到歌单」不在这里：播放页操作栏已经有同一个入口（在「收藏」左边），
        两处都能打开同一个面板属于重复。要恢复把这段和下面的 emit 一起加回来。
      -->

      <!-- 播放 MV -->
      <button type="button" class="row" :disabled="!albumAudioId" @click="openMv">
        <Icon :icon="iconVideo" width="20" height="20" class="row-icon" />
        <span class="row-label">播放 MV</span>
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>

      <!-- 弹幕：开关直写 setter，点行尾的主体区域展开外观设置 -->
      <div class="row row-with-switch">
        <button type="button" class="row-main" @click="toggleExpand('barrage')">
          <Icon :icon="iconBarrage" width="20" height="20" class="row-icon" />
          <span class="row-label">弹幕</span>
          <span class="row-value">{{ barrageEnabled ? '已开启' : '已关闭' }}</span>
          <span class="row-chevron" :class="{ 'is-open': expanded === 'barrage' }" aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          class="switch"
          :class="{ 'is-on': barrageEnabled }"
          role="switch"
          :aria-checked="barrageEnabled"
          aria-label="弹幕开关"
          @click="barrageEnabled = !barrageEnabled"
        ><span class="switch-knob" /></button>
      </div>
      <div v-if="expanded === 'barrage'" class="expander">
        <p class="expander-title">字号</p>
        <div class="chips">
          <button
            v-for="size in BARRAGE_FONT_SIZES"
            :key="size"
            type="button"
            class="chip"
            :class="{ 'is-active': Number(barrageConfig.fontSize) === size }"
            @click="setBarrageConfig({ fontSize: size })"
          >
            {{ size }}
          </button>
        </div>
        <p class="expander-title">速度</p>
        <div class="chips">
          <button
            v-for="speed in BARRAGE_SPEEDS"
            :key="speed"
            type="button"
            class="chip"
            :class="{ 'is-active': Number(barrageConfig.speed) === speed }"
            @click="setBarrageConfig({ speed })"
          >
            {{ speed }}×
          </button>
        </div>
        <p class="expander-title">不透明度</p>
        <div class="chips">
          <button
            v-for="value in BARRAGE_OPACITY"
            :key="value"
            type="button"
            class="chip"
            :class="{ 'is-active': Number(barrageConfig.opacity) === value }"
            @click="setBarrageConfig({ opacity: value })"
          >
            {{ value }}%
          </button>
        </div>
        <p class="expander-title">密度</p>
        <div class="chips">
          <button
            v-for="option in BARRAGE_DENSITY"
            :key="option.value"
            type="button"
            class="chip"
            :class="{ 'is-active': Number(barrageConfig.density) === option.value }"
            @click="setBarrageConfig({ density: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

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

/* ── 带开关的行：主体区可点开设置，右侧开关单独命中 ── */
.row-with-switch {
  display: flex;
  align-items: center;
  /* 左侧不留白：内层 .row-main 自己有同样的 8px，这里是外层，再留就变成双重缩进
     —— 弹幕那一行会比别的行右移 8px（实测 iconX 36 vs 28） */
  padding-left: 0;
  padding-right: var(--sp-2);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 52px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.row-main:active {
  background: var(--fill-subtle);
}

.switch {
  flex: 0 0 auto;
  position: relative;
  width: 44px;
  height: 26px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
  transition: background var(--duration-fast) var(--ease-standard);
}

.switch.is-on {
  background: var(--accent);
}

.switch-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.switch.is-on .switch-knob {
  transform: translateX(18px);
}

.expander-title {
  margin: var(--sp-3) 0 var(--sp-2);
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.expander-title:first-child {
  margin-top: 0;
}
</style>
