<script setup lang="ts">
/**
 * 歌词面板。
 *
 * ## 三个容易被做坏的地方
 *
 * 1. **不能和用户抢滚动**。
 *    自动居中是必需的，但用户主动上滑看后面的词时，如果每 ~200ms 又被拉回当前行，
 *    页面就"粘"住了。这里在手指按下/滚轮时暂停自动滚动 3.5 秒，之后恢复。
 *    判断用 pointerdown/wheel 而不是 scroll 事件 —— 程序化 smooth 滚动也会触发
 *    scroll，靠 scroll 事件区分"谁滚的"需要额外的时间戳启发式，不可靠。
 *
 * 2. **逐字高亮只作用于当前行**。
 *    如果把每一行都拆成一字一个 `<span>`，一首歌就是几千个节点，首屏直接卡住。
 *    这里只有当前行做逐字拆分（≤ 几十个），其余行是纯文本，切行时自然重建。
 *
 * 3. **位置由父级传入**（`positionMs`），不在这里自己读时钟。
 *    父级用 `useSmoothPosition()` 做了帧级外推；两处各自读 store 会出现
 *    "进度条已经走了、歌词还没切行"的不一致。
 *
 * 4. **没播放也要有歌词**。
 *    数据侧由 `useLyrics()` 里的 `ensureLyricsLoaded()` 保证（内核只在播放链路
 *    里拉歌词）；视觉侧由 `visualIndex` 保证 —— 未播放时 `currentIndex` 是 -1，
 *    若直接用它，整屏歌词全是暗的，用户会以为没加载出来。
 *
 * 渲染用 `displayLines`（已过用户配置的过滤/简繁转换，且与 currentIndex 对齐）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { LyricLine } from '@/stores/lyric';
import { useLyrics } from '@mobile/adapters/player';

const props = defineProps<{
  /** 平滑播放位置（毫秒） */
  positionMs: number;
  /** 面板是否可见；不可见时停掉滚动跟随，避免后台空转 */
  active: boolean;
}>();

const {
  lines,
  currentIndex,
  isLoading,
  tips,
  hasLines,
  showTranslation,
  showRomanization,
  fontScale,
  fontWeight,
  seekToLine,
} = useLyrics();

const scroller = ref<HTMLElement | null>(null);
const lineElements = ref<(HTMLElement | null)[]>([]);

/**
 * 视觉当前行（高亮 + 居中用）。
 *
 * 未播放时 `currentIndex` 是 -1（刚打开播放页、暂停后停在开头、或整首放完），
 * 直接用它会让整屏歌词全暗——用户看到的是「一堆灰字」，以为是没加载出来。
 * 所以退回第 0 行：既保留歌词可见性，也暗示「将从这句开始」。
 *
 * 点击跳转仍然用真实行下标（`seekToLine` 不受影响）。
 */
const visualIndex = computed(() => {
  if (currentIndex.value >= 0) return currentIndex.value;
  return lines.value.length ? 0 : -1;
});

/** 用户操作后暂停自动滚动到这个时间点 */
const USER_SCROLL_PAUSE_MS = 3500;
const userScrollUntil = ref(0);
const autoScrollPaused = computed(() => Date.now() < userScrollUntil.value);

const noteUserScroll = () => {
  userScrollUntil.value = Date.now() + USER_SCROLL_PAUSE_MS;
};

const setLineRef = (element: Element | null, index: number) => {
  lineElements.value[index] = (element as HTMLElement | null) ?? null;
};

const positionSec = computed(() => props.positionMs / 1000);

/**
 * 当前行的逐字进度。
 *
 * 只返回"已经唱到第几个字"，而不是给每个字算一次时间 ——
 * 这样每帧只重算一个整数，配合下面的 `v-for` 就能让 Vue 只改动变化的那一两个 class。
 */
const activeCharCount = computed(() => {
  // 没在播放（或还没开始）时不做逐字高亮：整行走普通文本，视觉上更安静
  if (currentIndex.value < 0) return -1;
  const line: LyricLine | undefined = lines.value[currentIndex.value];
  if (!line?.characters?.length) return -1;
  let count = 0;
  for (const character of line.characters) {
    if (Number(character.startTime) <= positionSec.value) count += 1;
    else break;
  }
  return count;
});

const centerCurrentLine = (behavior: ScrollBehavior = 'smooth') => {
  const container = scroller.value;
  const element = lineElements.value[visualIndex.value];
  if (!container || !element) return;
  const target =
    element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, target), behavior });
};

watch(
  () => visualIndex.value,
  async () => {
    if (!props.active || autoScrollPaused.value) return;
    // 等 DOM 更新完再量 offsetTop：行高会随字号/译文行数变化
    await nextTick();
    centerCurrentLine();
  },
);

// 面板从隐藏变可见时（用户从封面切回歌词）立刻对齐一次，不要停留在旧位置
watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await nextTick();
    centerCurrentLine('auto');
  },
);

watch(
  () => lines.value.length,
  async () => {
    if (!props.active) return;
    await nextTick();
    // 'auto'：首次加载歌词时不要平滑滚过整张列表
    centerCurrentLine('auto');
  },
);

onBeforeUnmount(() => {
  if (userScrollTimer !== null) window.clearTimeout(userScrollTimer);
});

// 让"暂停自动滚动"能自动过期（否则要等下一次滚动/切行判断才恢复）
let userScrollTimer: number | null = null;
watch(userScrollUntil, (until) => {
  if (userScrollTimer !== null) window.clearTimeout(userScrollTimer);
  if (!until) return;
  const delay = Math.max(0, until - Date.now()) + 50;
  userScrollTimer = window.setTimeout(() => {
    userScrollTimer = null;
    if (props.active) centerCurrentLine();
  }, delay);
});

const lineText = (line: LyricLine) => line.text || '♪';
</script>

<template>
  <div
    ref="scroller"
    class="lyrics"
    :style="{ '--lyric-scale': fontScale, '--lyric-weight': fontWeight }"
    @pointerdown="noteUserScroll"
    @wheel.passive="noteUserScroll"
    @touchmove.passive="noteUserScroll"
  >
    <div v-if="!hasLines" class="lyrics-empty">
      <p class="lyrics-empty-text">{{ isLoading ? '正在加载歌词…' : tips }}</p>
    </div>

    <template v-else>
      <!-- 上下留白：让第一行/最后一行也能滚到正中 -->
      <div class="lyrics-spacer" aria-hidden="true" />

      <p
        v-for="(line, index) in lines"
        :key="`${index}-${line.time}`"
        :ref="(element) => setLineRef(element as Element | null, index)"
        class="line"
        :class="{
          'is-active': index === visualIndex,
          'is-near': Math.abs(index - visualIndex) === 1,
        }"
        role="button"
        tabindex="0"
        @click="seekToLine(index)"
        @keyup.enter="seekToLine(index)"
      >
        <!-- 当前行逐字高亮；其余行整行文本 -->
        <span v-if="index === visualIndex && activeCharCount >= 0" class="line-text">
          <span
            v-for="(character, charIndex) in line.characters"
            :key="charIndex"
            class="char"
            :class="{ 'is-played': charIndex < activeCharCount }"
            >{{ character.text }}</span
          >
        </span>
        <span v-else class="line-text">{{ lineText(line) }}</span>

        <span v-if="showTranslation && line.translated" class="line-sub line-translated">
          {{ line.translated }}
        </span>
        <span v-if="showRomanization && line.romanized" class="line-sub line-romanized">
          {{ line.romanized }}
        </span>
      </p>

      <div class="lyrics-spacer" aria-hidden="true" />
    </template>
  </div>
</template>

<style scoped>
.lyrics {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  /* 触屏滑动交给浏览器；只有纵向滚动 */
  touch-action: pan-y;
  scrollbar-width: none;
  /* 上下边缘渐隐：暗示"上面还有词"，比硬切好看 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 12%,
    black 88%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 12%,
    black 88%,
    transparent 100%
  );
}

.lyrics::-webkit-scrollbar {
  display: none;
}

.lyrics-spacer {
  height: 42%;
}

.lyrics-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 var(--sp-6);
  text-align: center;
}

.lyrics-empty-text {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.line {
  margin: 0;
  padding: var(--sp-3) var(--sp-5);
  /* 字号与字重来自设置页（内核 lyric store 的 fontScale / fontWeightValue），
     用 CSS 变量下发，避免每行都算一遍内联样式 */
  font-size: calc(var(--font-lg) * var(--lyric-scale, 1));
  line-height: 1.5;
  color: var(--text-tertiary);
  text-align: center;
  transition:
    color var(--duration-normal) var(--ease-standard),
    transform var(--duration-normal) var(--ease-standard);
  /* 长按会弹选择菜单，歌词页不需要 */
  user-select: none;
  -webkit-user-select: none;
}

/* 相邻行稍微亮一点：让视线有落点，但不抢当前行 */
.line.is-near {
  color: var(--text-secondary);
}

.line.is-active {
  color: var(--text-primary);
  font-size: calc(var(--font-xl) * var(--lyric-scale, 1));
  font-weight: var(--lyric-weight, 700);
  transform: scale(1.02);
}

.line-sub {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--font-sm);
  font-weight: var(--weight-regular);
  color: var(--text-secondary);
}

/* ── 逐字高亮 ── */
.char {
  color: inherit;
  transition: color 120ms linear;
}

.line.is-active .char {
  /* 未唱到的字压在中等亮度上，正在唱的才给高亮色 */
  color: var(--text-secondary);
}

.line.is-active .char.is-played {
  color: var(--accent);
}
</style>
