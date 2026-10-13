/**
 * 播放适配层。
 *
 * 这是 UI 层**唯一**允许触碰 `@/stores/player` 与 `@/stores/playlist` 的地方。
 * 页面只拿到这里导出的语义化接口（`useNowPlaying()` / `usePlaybackActions()`），
 * 不直接读内核 store —— 两个好处：
 *
 * 1. 内核 store 里有大量桌面概念（DSP Provider、输出设备、系统媒体控制的
 *    桌面路径、`thumbar` IPC……），页面直接读会把它们渗进 UI；
 * 2. 内核升级时（`pnpm sync:upstream`）只要这一层的适配仍然成立，
 *    页面一行都不用改。反过来，如果页面直接引 store 字段，同步就是改 UI。
 *
 * ⚠️ 本模块静态 import 内核 store，因此**必须动态加载**（见 src/mobile/main.ts
 * 的启动顺序说明）—— 实际上它只会被懒加载的页面引用，天然满足。
 */
import { computed, ref } from 'vue';
import type { Song } from '@/models/song';
import type { PlayMode } from '@shared/playback';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { usePlaylistStore, MANUAL_PLAYBACK_QUEUE_ID } from '@/stores/playlist';
import { useHistoryStore } from '@/stores/historyStore';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import { playSongInContext } from '@/utils/playback';
import logger from '@/utils/logger';

/* ────────────────────────────────────────────────────────────
   启动引导
   ──────────────────────────────────────────────────────────── */

let bootstrapPromise: Promise<void> | null = null;

/**
 * 初始化播放内核（幂等）。
 *
 * 顺序照抄桌面 App.vue 的启动序列，因为这几步之间有真实依赖：
 *
 * 1. `waitForSqlitePersistHydration()` —— pinia 持久化是**异步**恢复的。
 *    早读 `currentTrackId` 会把"有历史播放"误判成"从没播过"。
 * 2. `hydratePlaybackStateFromStorage()` —— 从 storage 恢复播放队列快照。
 *    它必须在 `player.init()` 之前：init 会用恢复出来的队列去解析当前曲目。
 * 3. `historyStore.hydrate()` —— 本地播放历史，与队列恢复互不依赖，一起等即可。
 * 4. `player.init()` —— 恢复播放会话、注册系统媒体控制回调。
 *
 * 整个过程放在启动页里做（而不是进主界面后异步跑），因为 `player.init()` 会
 * 注册 MediaSession 回调；晚注册意味着用户在系统通知栏按暂停会丢事件。
 */
export const bootstrapPlayer = (): Promise<void> => {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    await waitForSqlitePersistHydration();

    const playlistStore = usePlaylistStore();
    const historyStore = useHistoryStore();
    const playerStore = usePlayerStore();

    await Promise.all([
      playlistStore.hydratePlaybackStateFromStorage(),
      historyStore.hydrate(),
    ]);

    await playerStore.init();
    logger.info('MobilePlayer', 'Player kernel ready');
  })().catch((error) => {
    // 失败不缓存：让下一次调用能重试（网络抖动导致的失败不该永久锁死播放）
    bootstrapPromise = null;
    throw error;
  });

  return bootstrapPromise;
};

/* ────────────────────────────────────────────────────────────
   只读状态
   ──────────────────────────────────────────────────────────── */

/**
 * 当前播放状态。
 *
 * 用 computed 包一层而不是直接把 store 暴露出去，是为了让 UI 只依赖
 * 「封面 / 标题 / 歌手 / 进度 / 是否在播」这几个语义，而不是 store 的字段名。
 */
export const useNowPlaying = () => {
  const player = usePlayerStore();

  const track = computed<Song | null>(() => (player.currentTrackSnapshot as Song) ?? null);
  const hasTrack = computed(() => Boolean(track.value?.id));
  const isPlaying = computed(() => player.isPlaying);
  const isLoading = computed(() => player.isLoading);

  const coverUrl = computed(
    () => track.value?.coverUrl || track.value?.cover || '',
  );
  const title = computed(() => track.value?.title || track.value?.name || '');
  const artist = computed(() => track.value?.artist || '');

  const currentTime = computed(() => player.currentTime);
  const duration = computed(() => player.duration);
  /** 0~1；引擎还没拿到时长时是 0（避免除零得到 NaN 宽度） */
  const progress = computed(() => {
    const total = duration.value;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.min(1, Math.max(0, currentTime.value / total));
  });

  const playMode = computed<PlayMode>(() => player.playMode);

  return {
    track,
    hasTrack,
    isPlaying,
    isLoading,
    coverUrl,
    title,
    artist,
    currentTime,
    duration,
    progress,
    playMode,
  };
};

/* ────────────────────────────────────────────────────────────
   操作
   ──────────────────────────────────────────────────────────── */

export interface PlayQueueMeta {
  queueId: string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
}

export const usePlaybackActions = () => {
  const player = usePlayerStore();
  const playlist = usePlaylistStore();

  /**
   * 在某个上下文列表里播放一首歌。
   *
   * 走内核的 `playSongInContext` 而不是自己拼 `setPlaybackQueueWithOptions` +
   * `playTrack`：那里面有一堆非平凡的处理（不可播曲目过滤与计数、随机模式的
   * 起播曲目选择、重复请求去重、`filteredInvalidCount` 计算），自己实现必然遗漏。
   */
  const playSong = async (song: Song, context: Song[], meta: PlayQueueMeta): Promise<boolean> => {
    const started = await playSongInContext(playlist, player, song, context, 0, {
      queueId: meta.queueId,
      title: meta.title,
      subtitle: meta.subtitle ?? '',
      coverUrl: meta.coverUrl,
      type: 'manual',
      // dynamic=false：曲目列表是快照，不在播放中动态追加
      dynamic: false,
    });
    if (started) logger.info('MobilePlayer', 'Play requested:', song.title);
    return started;
  };

  /** 播放（或在一个"临时列表"里播放：歌单/专辑/榜单详情页用） */
  const playList = async (
    list: Song[],
    meta: PlayQueueMeta,
    startIndex = 0,
  ): Promise<boolean> => {
    const first = list[startIndex];
    if (!first) return false;
    return playSong(first, list, meta);
  };

  const togglePlay = () => player.togglePlay();
  const next = () => player.next();
  const prev = () => player.prev();
  const seek = (time: number) => player.seek(time);
  const setPlayMode = (mode: PlayMode) => player.setPlayMode(mode);
  const setPlaybackRate = (rate: number) => player.setPlaybackRate(rate);

  /**
   * 手动队列（「下一首播放 / 添加到播放列表」这类动作）。
   * 队列 id 用内核的 MANUAL_PLAYBACK_QUEUE_ID，避免另造一个 id 让队列列表里
   * 出现两套"我的队列"。
   */
  const manualQueueMeta: PlayQueueMeta = {
    queueId: MANUAL_PLAYBACK_QUEUE_ID,
    title: '我的队列',
    subtitle: '',
  };

  const activeQueue = computed(() => playlist.activeQueue);

  /**
   * 从当前队列里跳播某一首（队列面板点击用）。
   * 显式传 `sourceQueueId`：内核靠它区分"同一个 id 出现在多个队列里"的情况，
   * 不传会回落到活动队列，在切换队列的瞬间可能播错。
   */
  const playFromActiveQueue = async (songId: string): Promise<boolean> => {
    const queue = playlist.activeQueue;
    if (!queue?.songs?.length) return false;
    if (String(player.currentTrackId ?? '') === String(songId) && player.isPlaying) return true;
    await player.playTrack(String(songId), queue.songs, { sourceQueueId: queue.id });
    return true;
  };

  return {
    playSong,
    playList,
    togglePlay,
    next,
    prev,
    seek,
    setPlayMode,
    setPlaybackRate,
    activeQueue,
    playFromActiveQueue,
    manualQueueMeta,
  };
};

/* ────────────────────────────────────────────────────────────
   UI 工具
   ──────────────────────────────────────────────────────────── */

/**
 * 秒 → `m:ss`。
 *
 * ⚠️ 单位是**秒**，不是毫秒。已核实上游约定（两边都是秒）：
 * · `utils/format.ts` 的 `formatDuration(seconds)` —— 列表里的 `song.duration`
 * · `components/player/PlayerBar.vue` 的 `formatTime(seconds)` —— 播放进度
 *   调用处是 `formatTime(player.currentTime)` / `formatTime(player.duration)`
 * · 原生侧回调也是秒（实测一段 5 秒的 WAV：`duration = 5`，
 *   `timePos` 两秒后为 1.936）；插件只在媒体控制那条路上乘 1000 换成毫秒。
 *
 * 按毫秒算的症状：所有时长显示 0:00（而且不会报错）。
 */
export const formatTime = (seconds: number): string => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalSeconds = Math.floor(safe);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

export const PLAY_MODE_ORDER: PlayMode[] = ['list', 'single', 'random', 'sequential'];

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  list: '列表循环',
  single: '单曲循环',
  random: '随机播放',
  sequential: '顺序播放',
};

/** 播放模式切换用的本地状态（避免每次都要读 store 才能决定下一个模式） */
export const usePlayModeSwitcher = () => {
  const player = usePlayerStore();
  const current = computed<PlayMode>(() => player.playMode);
  const cycle = () => {
    const index = PLAY_MODE_ORDER.indexOf(current.value);
    const nextMode = PLAY_MODE_ORDER[(index + 1) % PLAY_MODE_ORDER.length];
    player.setPlayMode(nextMode);
    return nextMode;
  };
  return { current, cycle, label: computed(() => PLAY_MODE_LABELS[current.value]) };
};

/* ────────────────────────────────────────────────────────────
   平滑播放位置
   ──────────────────────────────────────────────────────────── */

/**
 * 平滑的播放位置（毫秒）。
 *
 * 引擎的 `currentTime` 是**采样值**（原生侧按定时器上报，间隔远大于一帧），
 * 直接拿去驱动进度条会一格一格地跳，拿去驱动歌词逐字高亮更是完全不能用。
 *
 * 做法：用 `requestAnimationFrame` 在两次采样之间线性外推：
 * · 采样值一变就记下『这个值是什么时候拿到的』；
 * · 播放中用 `采样值 + (现在 - 采样时间) × 倍速` 作为当前值；
 * · 暂停/缓冲时不做外推（否则暂停后进度还会自己往前走）。
 *
 * 用 `playbackClock` 而不是 `currentTime`：前者把单位转换（秒 → 毫秒）和
 * 传输状态（isAdvancing）都算好了，避免又一处单位判断。
 *
 * 返回值用完即停（组件卸载时调用 `stop`），不要在页面外常驻 rAF。
 */
export const useSmoothPosition = () => {
  const player = usePlayerStore();
  const positionMs = ref(0);
  const durationMs = computed(() => Number(player.playbackClock?.durationMs ?? 0));

  let frame = 0;
  let sampledPosition = 0;
  let sampledAt = 0;

  const step = () => {
    const clock = player.playbackClock;
    const raw = Number(clock?.positionMs ?? 0);
    const now = performance.now();

    if (raw !== sampledPosition) {
      sampledPosition = raw;
      sampledAt = now;
    }

    const rate = Number(clock?.playbackRate ?? 1) || 1;
    const projected = clock?.isAdvancing
      ? sampledPosition + (now - sampledAt) * rate
      : sampledPosition;

    const durationMs = Number(clock?.durationMs ?? 0);
    positionMs.value = durationMs > 0 ? Math.min(projected, durationMs) : projected;

    frame = window.requestAnimationFrame(step);
  };

  const start = () => {
    if (frame) return;
    sampledPosition = 0;
    sampledAt = performance.now();
    frame = window.requestAnimationFrame(step);
  };

  const stop = () => {
    if (!frame) return;
    window.cancelAnimationFrame(frame);
    frame = 0;
  };

  return { positionMs, durationMs, start, stop };
};

/* ────────────────────────────────────────────────────────────
   歌词
   ──────────────────────────────────────────────────────────── */

/**
 * 歌词视图数据。
 *
 * **不需要自己拉歌词** —— 内核的 player store 在切歌时会调
 * `lyricStore.fetchLyrics(hash, ...)`，并且用播放时钟驱动
 * `updateCurrentIndex()`。这里只负责读。
 *
 * ⚠️ 渲染用 `displayLines` 而不是 `lines`：前者已经过用户配置的
 * 正则过滤与简繁转换，且与 `currentIndex` 索引对齐。
 */
export const useLyrics = () => {
  const lyric = useLyricStore();

  const lines = computed(() => lyric.displayLines ?? []);
  const currentIndex = computed(() => lyric.currentIndex);
  const isLoading = computed(() => lyric.isLoading);
  /** 无歌词时显示的原因文本（内核给的是人话，如「纯音乐，请欣赏」） */
  const tips = computed(() => lyric.tips || '暂无歌词');
  const hasLines = computed(() => lines.value.length > 0);

  const showTranslation = computed(() => lyric.showTranslation);
  const showRomanization = computed(() => lyric.showRomanization);

  /** 点击某行 → 跳到该行时间点（秒） */
  const seekToLine = (index: number) => {
    const line = lines.value[index];
    if (!line) return;
    // 用内核算好的有效偏移回退，否则用户调过偏移后点击跳转会偏
    const offsetMs = Number(lyric.currentTimeOffset ?? 0);
    void usePlayerStore().seek(Math.max(0, line.time - offsetMs / 1000));
  };

  return {
    lines,
    currentIndex,
    isLoading,
    tips,
    hasLines,
    showTranslation,
    showRomanization,
    seekToLine,
  };
};

/** 播放页是否打开（移动端用路由控制，这里只是给外壳按钮用） */
export const nowPlayingRouteName = 'player';

/** 空封面时的占位（避免 <img> 加载失败出现破图） */
export const useCoverFallback = () => {
  const failed = ref(false);
  return { failed };
};
