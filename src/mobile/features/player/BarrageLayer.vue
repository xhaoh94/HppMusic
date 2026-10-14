<script setup lang="ts">
/**
 * 播放页弹幕层。
 *
 * ## 只做"看"，不做"发"
 *
 * 发送要走 `comment/song-barrage/send`，会**产生公开内容且需要审核**（服务端审核中
 * 返回的列表可能是空的），所以这一版只做展示 + 开关 + 外观设置。
 *
 * ## 算法全部复用内核，不在这里重写
 *
 * `@/utils/barrage` 里已经有整套工具，而且和桌面端共用同一份配置语义：
 *
 * | 工具 | 作用 |
 * |---|---|
 * | `normalizeBarrageItems` | 解析接口响应（取 `content` / `user_id`、丢空串、截断到 100） |
 * | `getFreeBarrageLane` | 4 条轨道里找一条空的 |
 * | `barrageTravelDuration` | 按「容器宽 + 文字宽」和速度算飞行时长 |
 * | `nextBarrageItem` | 取下一句（带"刚展示过的"冷却，避免同一条连着刷） |
 *
 * ## 用 CSS 动画而不是 JS 逐帧
 *
 * 100 条弹幕逐帧算 `translateX` 会一直占着主线程（系统本身在播歌 + 滚歌词）。
 * 这里在节点插入时**测一次**宽度，把起点、距离、时长一起写进元素，之后交给
 * 合成器跑动画；`animationend` 回收。窗口尺寸变化也不会让飞行中的弹幕突然加速
 * （因为距离与时长是同一次测量得出的）。
 *
 * 暂停用 `animation-play-state`，不销毁节点 —— 恢复播放时弹幕从原位置继续。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Directive } from 'vue';
import { useSettingStore } from '@/stores/setting';
import {
  barrageTravelDuration,
  getFreeBarrageLane,
  nextBarrageItem,
  type BarrageItem,
} from '@/utils/barrage';
import { fetchSongBarrage } from '@mobile/adapters/comment';

const props = defineProps<{
  /** 歌曲 hash（32 位）。为空表示这首没有可取弹幕的标识，直接不拉 */
  hash: string;
  /** 正在播放吗：暂停时不发射新弹幕，飞行中的也停住 */
  playing: boolean;
}>();

const setting = useSettingStore();

const config = computed(() => setting.lyricBarrageConfig);
const enabled = computed(() => Boolean(setting.lyricBarrageEnabled));

type Flight = BarrageItem & { id: number; lane: number };

const items = shallowRef<BarrageItem[]>([]);
const flights = ref<Flight[]>([]);
const loading = ref(false);
const error = ref('');

let cursor = 0;
let sequence = 0;
let timer: ReturnType<typeof setInterval> | undefined;
/** 请求代数：切歌时自增，旧请求回来直接丢弃 */
let generation = 0;

/** 有弹幕可放、且用户在播、且开关开着、且面板可见 */
const running = computed(
  () =>
    enabled.value &&
    props.playing &&
    Boolean(props.hash) &&
    (items.value.length > 0 || flights.value.length > 0),
);

/** 发射间隔跟随"密度"设置（内核的 density：1 稀疏 / 2 正常 / 3 密集） */
const intervalOf = (density: number) => {
  if (density === 1) return 4500;
  if (density === 3) return 1400;
  return 2800;
};

/**
 * 测一次宽度并把「起点 + 距离 + 时长」写进元素。
 *
 * 三处用同一次测量：`left` 是起点、`--barrage-distance` 是位移、时长由两者算出。
 * 分开测会让文字宽度变化时（字体没加载完）飞行速度和理论值不一致。
 */
const vFlightMotion: Directive<HTMLElement, number> = {
  mounted(element, binding) {
    const width = element.parentElement?.getBoundingClientRect().width ?? 0;
    const textWidth = element.getBoundingClientRect().width;
    element.style.left = `${width}px`;
    element.style.setProperty('--barrage-distance', `${width + textWidth}px`);
    element.style.animationDuration = `${barrageTravelDuration(width, textWidth, binding.value)}s`;
  },
};

const launchNext = () => {
  if (!running.value) return;
  const lane = getFreeBarrageLane(flights.value);
  // 4 条轨道都被占着就跳过这一拍，等 animationend 腾出来
  if (lane < 0) return;
  const next = nextBarrageItem(items.value, cursor, new Map(), Date.now());
  cursor = next.cursor;
  if (next.item) flights.value.push({ ...next.item, id: ++sequence, lane });
};

const finishFlight = (id: number) => {
  flights.value = flights.value.filter((flight) => flight.id !== id);
  // 刚腾出轨道就补一条，不用等下一拍
  launchNext();
};

const load = async () => {
  const token = ++generation;
  items.value = [];
  flights.value = [];
  cursor = 0;
  error.value = '';
  if (!props.hash) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const list = await fetchSongBarrage(props.hash);
    if (token !== generation) return;
    items.value = list;
  } catch (e) {
    if (token !== generation) return;
    error.value = e instanceof Error ? e.message : '弹幕加载失败';
  } finally {
    if (token === generation) loading.value = false;
  }
};

// 切歌 → 重新拉；开关打开 → 立刻拉（关闭时不请求，省流量）
watch(
  [() => props.hash, enabled],
  () => {
    if (!enabled.value) {
      items.value = [];
      flights.value = [];
      return;
    }
    void load();
  },
  { immediate: true },
);

// 改变几何/速度设置时清空飞行轨迹：否则正在跑的动画会突然跳位
watch(
  () => [config.value.fontSize, config.value.speed, config.value.area],
  () => {
    flights.value = [];
  },
);

watch(
  [running, () => config.value.density],
  ([isRunning]) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (isRunning) timer = setInterval(launchNext, intervalOf(Number(config.value.density) || 2));
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  generation += 1;
  if (timer) clearInterval(timer);
});

const statusText = computed(() => {
  if (loading.value) return '弹幕加载中…';
  if (error.value) return '弹幕加载失败，可在「更多」里关闭后重试';
  return '暂无弹幕';
});
const showStatus = computed(
  () => !flights.value.length && (loading.value || Boolean(error.value) || !items.value.length),
);
</script>

<template>
  <div class="barrage-layer" :class="{ 'is-paused': !running }" aria-hidden="true">
    <div
      v-if="enabled"
      class="barrage-area"
      :style="{
        height: `calc(${config.area}% - 24px)`,
        opacity: Number(config.opacity) / 100,
      }"
    >
      <span
        v-for="flight in flights"
        :key="flight.id"
        v-flight-motion="Number(config.speed) || 1"
        class="barrage-flight"
        :style="{
          top: `calc(${flight.lane * 25}% + 2px)`,
          fontSize: `${config.fontSize}px`,
        }"
        @animationend="finishFlight(flight.id)"
        >{{ flight.text }}</span
      >
    </div>
    <p v-if="enabled && showStatus" class="barrage-status">{{ statusText }}</p>
  </div>
</template>

<style scoped>
.barrage-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  /* 弹幕不吃点击：下面的歌词行要能正常点（点歌词跳转） */
  pointer-events: none;
}

.barrage-area {
  position: absolute;
  left: 0;
  right: 0;
  top: 8px;
  overflow: hidden;
}

.barrage-flight {
  position: absolute;
  left: 100%;
  /* 超长弹幕（有用户发几百字的）会让一条横条占满整屏并抢占轨道很久，
     限宽 + 省略号：弹幕是扫一眼的东西，不必完整展示 */
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  color: #fff;
  /* 双阴影压边：任意底色（封面模糊 / 写真图）上都能读 */
  text-shadow:
    0 1px 3px #000,
    1px 0 2px #000;
  animation: barrage-fly 10s linear forwards;
  will-change: transform;
}

/* 暂停时停住动画，而不是清掉弹幕（恢复播放从原位继续） */
.is-paused .barrage-flight {
  animation-play-state: paused;
}

.barrage-status {
  position: absolute;
  right: var(--sp-4);
  top: 12px;
  margin: 0;
  font-size: var(--font-xs);
  color: rgba(255, 255, 255, 0.7);
  text-shadow: 0 1px 3px #000;
}

@keyframes barrage-fly {
  to {
    transform: translateX(calc(-1 * var(--barrage-distance)));
  }
}

/* 系统开了"减弱动态效果"时退化成淡出，避免大面积移动引起不适 */
@media (prefers-reduced-motion: reduce) {
  .barrage-flight {
    left: 12px !important;
    animation-name: barrage-fade;
  }
}

@keyframes barrage-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
