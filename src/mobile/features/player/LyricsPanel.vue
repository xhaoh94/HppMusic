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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { LyricLine } from '@/stores/lyric';
import { useLyrics } from '@mobile/adapters/player';

const props = defineProps<{
  /** 平滑播放位置（毫秒） */
  positionMs: number;
  /** 面板是否可见；不可见时停掉滚动跟随，避免后台空转 */
  active: boolean;
}>();

/** 点击歌词区**空白处**（不是某一行歌词）时抛出，播放页用它切换皮肤。 */
const emit = defineEmits<{ backgroundClick: [] }>();

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
/**
 * 必须是函数，不能是 computed：computed 的依赖里没有时间源，过期后不会重新求值，
 * 会把 true 一直缓存下去 —— 用户碰一次歌词区，自动滚动就永久死亡
 * （实测现象：歌词不再跟随播放滚动）。函数每次判断都读当前时间，到期自动恢复。
 */
const autoScrollPaused = () => Date.now() < userScrollUntil.value;

const noteUserScroll = () => {
  userScrollUntil.value = Date.now() + USER_SCROLL_PAUSE_MS;
};

const setLineRef = (element: Element | null, index: number) => {
  lineElements.value[index] = (element as HTMLElement | null) ?? null;
};

/**
 * 当前行的逐字进度。
 *
 * 只返回"已经唱到第几个字"，而不是给每个字算一次时间 ——
 * 这样每帧只重算一个整数，配合下面的 `v-for` 就能让 Vue 只改动变化的那一两个 class。
 *
 * ⚠️ `characters[].startTime` 是**毫秒**（KRC 的原始单位，见 stores/lyric.ts 的解析），
 * 必须和 `props.positionMs` 比。拿 `positionMs / 1000` 去比是单位错位 ——
 * 逐字进度会永远停在 0，当前行整行保持暗灰（实测现象：看着像"高亮后字色又被改回灰"）。
 */
let progressLine = -1;
let progressMax = 0;
let progressPeakMs = 0;

const activeCharCount = computed(() => {
  // 没在播放（或还没开始）时不做逐字高亮：整行走普通文本，视觉上更安静
  if (currentIndex.value < 0) return -1;
  const index = currentIndex.value;
  const line: LyricLine | undefined = lines.value[index];
  if (!line?.characters?.length) return -1;

  let count = 0;
  for (const character of line.characters) {
    if (Number(character.startTime) <= props.positionMs) count += 1;
    else break;
  }

  // 只增不减：平滑时钟每次与 store 同步都会把外推值往回拉一点，没有这个下界，
  // 唱过的字会随每次同步闪回灰色。倒退超过 2 秒才算用户 seek，那时才重置。
  const jumpedBack = props.positionMs < progressPeakMs - 2000;
  if (index !== progressLine || jumpedBack) {
    progressLine = index;
    progressMax = 0;
    progressPeakMs = props.positionMs;
  }
  if (count > progressMax) progressMax = count;
  if (props.positionMs > progressPeakMs) progressPeakMs = props.positionMs;
  return progressMax;
});

const centerCurrentLine = (behavior: ScrollBehavior = 'smooth') => {
  const container = scroller.value;
  const element = lineElements.value[visualIndex.value];
  if (!container || !element) return;
  // 用视口坐标差算偏移，不用 offsetTop：.lyrics 没设 position，offsetParent 是
  // .player-stage，offsetTop 会把封面/歌名区的高度算进来 —— 封面模式下当前行
  // 被顶出可见区（歌词模式误差小所以没暴露）。rect 差值与 offsetParent 无关。
  const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const target =
    container.scrollTop + delta - (container.clientHeight - element.clientHeight) / 2;
  container.scrollTo({ top: Math.max(0, target), behavior });
};

watch(
  () => visualIndex.value,
  async () => {
    if (!props.active || autoScrollPaused()) return;
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
  // 监听数组本身而不是 length：换一首行数相同的歌时 length 不变，
  // 不重新对齐就会停在上一首歌的滚动位置
  () => lines.value,
  async () => {
    if (!props.active) return;
    await nextTick();
    // 'auto'：首次加载歌词时不要平滑滚过整张列表
    centerCurrentLine('auto');
  },
);

/**
 * 容器尺寸变化后重新对齐。
 *
 * 封面模式下歌词区只剩一两百像素高，切视图模式、改字号、封面加载后撑开布局，
 * 都会让中心悄悄偏掉 —— 而这些变化不改变任何被 watch 的值，行高变了、
 * currentIndex 没变，就没人去重新居中。ResizeObserver 兜住这一类。
 * 用户正在手动滚动期间不抢（autoScrollPaused）。
 */
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  if (!scroller.value || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    if (!props.active || autoScrollPaused()) return;
    centerCurrentLine('auto');
  });
  resizeObserver.observe(scroller.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
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

/**
 * 选中行（点击歌词行后出现）。
 *
 * 直接点歌词就跳转体验不好（想上下看看词就误跳了），所以改成两步：
 * 点一下选中 → 行右侧出现一条竖线 + 中间的播放按钮 → 点按钮才真的跳转。
 */
const selectedIndex = ref<number | null>(null);

// 换歌/歌词重新加载时清掉选中，避免指向已经不存在的行
watch(lines, () => {
  selectedIndex.value = null;
});

/* ── 点空白处换肤 ── */

/** 按下位置：用来区分「点击」与「拖动滚动」（后者不能换肤） */
const pointerStart = { x: 0, y: 0, armed: false, onText: false };

const onPointerDown = (event: PointerEvent) => {
  noteUserScroll();
  pointerStart.x = event.clientX;
  pointerStart.y = event.clientY;
  pointerStart.armed = true;
  // ⚠️ 必须在**按下时**就判定是不是按在文字上：
  // 点文字会先跳行，跳行立即滚动歌词，等浏览器补发 click 时那一行已经移开，
  // 到 click 再去量位置就会误判成“点空白”而多切一次皮肤（实测就是这样）。
  pointerStart.onText = hitLineText(event.clientX, event.clientY);
};

/** 某个坐标是否落在歌词文字上。 */
const hitLineText = (x: number, y: number): boolean => {
  const element = document.elementFromPoint(x, y);
  const line = element instanceof Element ? element.closest('.line') : null;
  if (!line) return false;
  const boxes = line.querySelectorAll('.line-text, .line-sub');
  // 容差 4px：文字边缘那一下不该因为像素取整变成“空白”
  const hit = (rect: DOMRect) =>
    x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
  if (boxes.length === 0) return hit(line.getBoundingClientRect());
  return Array.from(boxes).some((box) => hit(box.getBoundingClientRect()));
};

/** 本次点击（或按下）是否算“点在歌词文字上” */
const clickedLineText = (event: MouseEvent): boolean =>
  pointerStart.armed ? pointerStart.onText : hitLineText(event.clientX, event.clientY);

const onPanelClick = (event: MouseEvent) => {
  // 点右侧的“从这里播放”行动区：由按钮自己处理，既不是跳行也不是换皮
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.line-action')) return;
  const onText = clickedLineText(event);
  const moved =
    pointerStart.armed &&
    (Math.abs(event.clientX - pointerStart.x) > 8 ||
      Math.abs(event.clientY - pointerStart.y) > 8);
  pointerStart.armed = false;
  // 点文字 = 选中这一行（右侧出现播放按钮）；拖动 = 滚动歌词：两者都不换皮肤
  if (onText || moved) return;
  selectedIndex.value = null;
  emit('backgroundClick');
};

/** 行内点击：先选中，真正跳转要再点右侧的播放按钮。 */
const toggleSelect = (index: number) => {
  selectedIndex.value = selectedIndex.value === index ? null : index;
};

const onLineClick = (event: MouseEvent, index: number) => {
  if (!clickedLineText(event)) return;
  toggleSelect(index);
};

/** 选中行的“从这里播放”。 */
const playSelected = (index: number) => {
  selectedIndex.value = null;
  seekToLine(index);
};
</script>

<template>
  <div
    ref="scroller"
    class="lyrics"
    :style="{ '--lyric-scale': fontScale, '--lyric-weight': fontWeight }"
    @pointerdown="onPointerDown"
    @wheel.passive="noteUserScroll"
    @touchmove.passive="noteUserScroll"
    @click="onPanelClick"
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
        :class="{ 'is-active': index === visualIndex, 'is-selected': index === selectedIndex }"
        role="button"
        tabindex="0"
        @click="onLineClick($event, index)"
        @keyup.enter="toggleSelect(index)"
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

        <!-- 选中后的跳转入口：右侧一条竖线，中间是播放按钮 -->
        <span v-if="index === selectedIndex" class="line-action">
          <span class="line-action-rail" aria-hidden="true" />
          <button
            type="button"
            class="line-action-play"
            :aria-label="`从这里播放：${lineText(line)}`"
            @click.stop="playSelected(index)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
            </svg>
          </button>
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
  position: relative;
  margin: 0;
  padding: var(--sp-3) var(--sp-5);
  /* 字号与字重来自设置页（内核 lyric store 的 fontScale / fontWeightValue），
     用 CSS 变量下发，避免每行都算一遍内联样式 */
  font-size: calc(var(--font-lg) * var(--lyric-scale, 1));
  line-height: 1.5;
  /* 暗行灰：酷狗概念版截屏采样 #646464，比 tertiary 再暗一档 */
  color: var(--lyric-dim);
  text-align: center;
  transition:
    color var(--duration-normal) var(--ease-standard),
    transform var(--duration-normal) var(--ease-standard);
  /* 长按会弹选择菜单，歌词页不需要 */
  user-select: none;
  -webkit-user-select: none;
}

/* 选中行：右侧让出播放按钮的位置，避免长句被按钮盖住 */
.line.is-selected {
  padding-right: calc(var(--sp-5) + 30px);
  color: var(--text-secondary);
}

/*
 * 选中行右侧的跳转入口：一条竖线 + 居中播放按钮。
 * 放在行内绝对定位，不参与文本流，因此不会把歌词推歪。
 */
.line-action {
  position: absolute;
  top: 50%;
  right: var(--sp-2);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 100%;
  transform: translateY(-50%);
}

.line-action-rail {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 50%;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  transform: translateX(-50%);
  opacity: 0.85;
}

.line-action-play {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--accent-on);
  background: var(--accent);
  /* 给竖线留出看不见的间隙，按钮看起来是“嵌在线上” */
  box-shadow: 0 0 0 3px var(--bg-base);
}

.line-action-play:active {
  transform: scale(0.92);
}

/* 注：没有"相邻行加亮"——当前行逐字还没唱到时整行是暗的，邻居一旦更亮，
   看起来就像高亮跑到了两行上（实测踩过）。酷狗概念版也是所有非当前行同一种灰。 */

/* 当前行：无底带，聚焦全靠"唱到的字纯白 + 字号大一级"——酷狗概念版同款，
   截图采样：唱到 #FFF / 未唱 #646464 / 非当前行 #646464 */
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
  /* 副行（翻译/音译）跟随暗行的灰，不能比原词还亮 */
  color: var(--lyric-dim);
}

/* 当前行的译文比纯白稍暗，保持层级 */
.line.is-active .line-sub {
  color: var(--text-secondary);
}

/* ── 逐字高亮 ── */
.char {
  color: inherit;
  transition: color 120ms linear;
}

/* 逐字高亮：未唱到的字与普通行同灰，正在唱到的亮 */
.line.is-active .char {
  color: var(--lyric-dim);
}

.line.is-active .char.is-played {
  color: var(--text-primary);
}
</style>
