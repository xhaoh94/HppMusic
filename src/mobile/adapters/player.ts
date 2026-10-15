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
import { computed, ref, watch } from 'vue';
import type { Song } from '@/models/song';
import type { PlayMode } from '@shared/playback';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { isLyricLineFiltered, resolveVisibleLyricIndex } from '@/utils/lyricFilter';
import { usePlaylistStore, MANUAL_PLAYBACK_QUEUE_ID } from '@/stores/playlist';
import { useHistoryStore } from '@/stores/historyStore';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import { replaceQueueAndPlay } from '@/utils/playback';
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

/** 「启动时自动播放」第一次尝试的延迟：等启动那批请求落定（见 bootstrapPlayer 内的说明） */
const LAUNCH_RESUME_FIRST_DELAY_MS = 3000;
/** 仍失败时的重试延迟（在第一次之后再加这么多） */
const LAUNCH_RESUME_RETRY_MS = 5000;

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

    /**
     * 「启动时自动播放」：冷启动恢复上次队列后自动续播。
     *
     * 开关是内核 setting 的（autoPlayOnLaunch），桌面端由它的视图层读 ——
     * 移动端没有那一层，不在这里接就是个"能拨但没反应"的死开关
     * （实测：设置开着冷启动后原生媒体会话 state=0，什么都没放）。
     *
     * ⚠️ 取链失败要重试一次：启动瞬间首页会同时发一大批请求，取播放地址容易被
     * 挤掉/超时（用户报的"启动时自动播放失败、同一首歌手动点又能播"就是这一种），
     * 而失败会弹一次"无法获取可用音源"。隔几秒网络安静下来再试一次基本都能成功。
     * 只在"还停在恢复出来的那首、且没在播"时重试，避免和用户手动播放打架。
     */
    if (
      useSettingStore().autoPlayOnLaunch &&
      playerStore.currentTrackId &&
      !playerStore.isPlaying
    ) {
      const resumeTrackId = String(playerStore.currentTrackId);
      /**
       * 把"恢复出来的曲目"长什么样记进日志。
       *
       * `hasAudioUrl` 是关键：曲目对象上带着上次会话的旧地址时，解析会走
       * "复用当前源"分支，拿到的是过期 URL —— 这正是"启动续播失败、但手动点
       * 同一首又能播"最可能的解释（手动播放用的是列表里的新对象，不带旧地址）。
       */
      const resumeSnapshot = playerStore.currentTrackSnapshot as Song | null;
      logger.info('MobilePlayer', 'Launch resume attempt', {
        trackId: resumeTrackId,
        hash: String(resumeSnapshot?.hash ?? ''),
        albumAudioId: String(
          resumeSnapshot?.albumAudioId ?? resumeSnapshot?.mixSongId ?? '',
        ),
        hasAudioUrl: Boolean(resumeSnapshot?.audioUrl),
      });
      /**
       * ⚠️ 第一次尝试也必须等启动那批请求过去，不能立刻发。
       *
       * 实测（真机日志）：启动后立刻尝试 → 解析器在"取链"之前就返回空地址 ——
       * 内核 `qualityAccessStore.captureAccessRequest()` 的序号被首页那批并发请求
       * 顶掉，`isCurrentQualityAccess()` 判为过期，`resolver.ts:611` 直接
       * `return { url: '' }`（所以日志里连一条取链请求都没有）。
       * 后果是启动时稳定弹一次"播放失败"、3 秒后还会自动切歌。
       * 等首页那批请求落定再试就正常 —— 同一个网络、同一首歌。
       */
      const resume = () => {
        if (
          playerStore.isPlaying ||
          String(playerStore.currentTrackId ?? '') !== resumeTrackId
        ) {
          return;
        }
        // 不 await：取播放地址要一次网络往返，别拖住启动；失败只记日志
        void Promise.resolve(playerStore.togglePlay()).catch((error) => {
          logger.warn('MobilePlayer', 'Auto play on launch failed', error);
        });
      };

      window.setTimeout(resume, LAUNCH_RESUME_FIRST_DELAY_MS);
      window.setTimeout(() => {
        resume();
        /**
         * 重试后仍没播起来 → 把关键状态写进日志。
         *
         * 这条是给"从设备上定位"用的：用户报的现象是启动续播失败、同一首歌手动
         * 点又能播。有这几个字段就能判断是"曲目对象缺字段（hash/albumAudioId）"
         * 还是"上游/网络拒绝"。
         */
        if (!playerStore.isPlaying) {
          const snapshot = playerStore.currentTrackSnapshot as Song | null;
          logger.warn('MobilePlayer', 'Auto play on launch still idle after retry', {
            trackId: playerStore.currentTrackId,
            hash: String(snapshot?.hash ?? ''),
            albumAudioId: String(snapshot?.albumAudioId ?? snapshot?.mixSongId ?? ''),
            hasAudioUrl: Boolean(snapshot?.audioUrl),
            lastError: playerStore.lastError,
          });
        }
      }, LAUNCH_RESUME_FIRST_DELAY_MS + LAUNCH_RESUME_RETRY_MS);
    }
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
   * ⚠️ 必须用 `replaceQueueAndPlay`（**整个列表替换队列**），
   * 而不是看起来更合适的 `playSongInContext`：
   *
   * `playSongInContext(store, player, song, contextSongs, ..., { queueId })`
   * 在 `contextSongs.length > 0 && options.queueId` 时会**转走 `queueAndPlaySong`**
   * —— 那是"把单首歌追加进队列"的语义。于是传 30 首上下文进去，
   * 队列里只会有 1 首（加上队列里原有的），表现为"播完这首就停"。
   *
   * 实测：每日推荐点"播放全部"后 `activeQueue.songs.length === 2`（应该是 30）。
   *
   * `replaceQueueAndPlay` 才是"用这个列表当播放队列，并从指定那首开始放"，
   * 并且内部已经处理了不可播曲目过滤与计数、随机模式起播曲目选择、
   * 重复请求去重。
   */
  const playSong = async (song: Song, context: Song[], meta: PlayQueueMeta): Promise<boolean> => {
    const list = context.length ? context : [song];
    const started = await replaceQueueAndPlay(playlist, player, list, 0, song, {
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

  /** 把整个列表当队列并从 startIndex 开始播（"播放全部"用） */
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

  /* ────────────────────────────────────────────────────────
     收藏
     ──────────────────────────────────────────────────────── */

  /** 当前曲目是否已收藏（响应式） */
  const isCurrentFavorite = computed(() => {
    const song = player.currentTrackSnapshot as Song | null;
    if (!song) return false;
    return playlist.isFavoriteSong(song);
  });

  /**
   * 切换收藏状态。
   *
   * 必须走 `ensureLikedPlaylistReady()` 拿 listId：「我喜欢」是一个**服务端歌单**，
   * 收藏 = 往那个歌单里加歌，光有歌曲对象不够（该动作内部会按需拉用户歌单）。
   *
   * 返回值表示切换后的状态（true=现在已收藏），让调用方能直接推进 UI。
   */
  const toggleFavorite = async (song: Song): Promise<boolean> => {
    const { listId } = await playlist.ensureLikedPlaylistReady();
    if (!listId) throw new Error('未找到「我喜欢」歌单，请稍后重试');

    if (playlist.isFavoriteSong(song)) {
      await playlist.removeFromPlaylist(listId, song);
      return false;
    }
    const result = await playlist.addToPlaylist(listId, song);
    if (result === 'failed') throw new Error('收藏失败，请稍后重试');
    // 'exists' 也算已收藏（服务端已经有一份，正常场景下不会走到）
    return true;
  };

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

  /**
   * 当前队列里、当前曲目**之后**还剩几首。
   *
   * 用于「快播完时就预取下一批」—— 等真正播完最后一首再去拉，接口往返要 1~2 秒，
   * 中间会有明显的一段静音。
   */
  const remainingInQueue = computed(() =>
    playlist.getQueueRemainingSongCount(
      String(playlist.activeQueue?.id ?? ''),
      player.currentTrackId,
    ),
  );

  /**
   * 往当前队列**末尾追加**（内核会去重）。
   *
   * 与 `playSong` / `playList` 的区别：那两个是**替换**整个队列（`replaceQueueAndPlay`），
   * 这个只追加、不动正在播的那首。
   *
   * 返回实际追加的条数（全被去重掉时是 0）。
   */
  const appendToActiveQueue = (songs: Song[]): number => {
    const queueId = String(playlist.activeQueue?.id ?? '');
    if (!queueId || !songs.length) return 0;
    return playlist.appendToPlaybackQueue(songs, { queueId });
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
    isCurrentFavorite,
    toggleFavorite,
    remainingInQueue,
    appendToActiveQueue,
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
 * 确保「当前曲目」的歌词已开始加载（幂等）。
 *
 * 内核对歌词的加载**只挂在播放链路上** —— `selectTrack` / `play` / `playQueue`
 * 里才会调 `lyricStore.fetchLyrics`。于是冷启动恢复播放会话时，曲目已经躺在
 * `currentTrackSnapshot` 里、播放页标题歌手都正常，但没有任何一次「播放」发生，
 * 歌词就一直是「暂无歌词」。用户看到的现象是**必须点一下播放才有歌词**。
 *
 * 判据只用 `loadedHash !== hash`：`loadedHash` 是内核「这首歌我已经处理过」的标记
 * （加载成功、加载中、以及确认没歌词都会写上），所以这里不会对同一首歌反复请求。
 * `fetchLyrics` 自己还有两道闸（已有歌词直接返回、同名在途去重），双保险。
 */
export const ensureLyricsLoaded = () => {
  const player = usePlayerStore();
  const lyric = useLyricStore();

  const track = player.currentTrackSnapshot as Song | null;
  if (!track) return;

  const hash = String(track.hash ?? track.id ?? '').trim();
  if (!hash) return;
  // 内核已经处理过这首（成功 / 进行中 / 确认无词）—— 不要再插手
  if (lyric.loadedHash === hash || lyric.isLoading) return;

  void lyric.fetchLyrics(hash, {
    duration: track.duration ? track.duration * 1000 : 0,
    track,
  });
};

/**
 * 歌词视图数据。
 *
 * 内核的 player store 在切歌时会调 `lyricStore.fetchLyrics(hash, ...)`，并且用
 * 播放时钟驱动 `updateCurrentIndex()` —— 但那只覆盖了「播放过」的路径。
 * 本函数在挂载/切歌时补一次 `ensureLyricsLoaded()`，让**没播放也能看到歌词**。
 *
 * ⚠️ 渲染用 `displayLines` 而不是 `lines`：前者已经过用户配置的
 * 正则过滤与简繁转换，且与 `currentIndex` 索引对齐。
 */
export const useLyrics = () => {
  const lyric = useLyricStore();
  const setting = useSettingStore();
  const player = usePlayerStore();

  /**
   * 当前曲目的歌词键（与内核取 hash 的规则一致）。
   * 单独拎出来是为了给下面的 watch 一个稳定字段，避免整对象比较导致的重复触发。
   */
  const currentHash = computed(() => {
    const track = player.currentTrackSnapshot as Song | null;
    return track ? String(track.hash ?? track.id ?? '').trim() : '';
  });

  // 一挂载就补一次：恢复会话后用户直接打开播放页也能看到歌词
  watch(currentHash, () => ensureLyricsLoaded(), { immediate: true });

  const filterConfig = computed(() => ({
    enabled: Boolean(setting.lyricFilterEnabled),
    pattern: String(setting.lyricFilterPattern ?? ''),
  }));

  /**
   * 可见行在原数组里的下标。
   *
   * 过滤不能只靠 CSS 隐藏：`display: none` 的元素没有布局盒，`offsetTop` 归零，
   * 歌词自动居中就失效了。所以这里**真的把行从渲染数组里去掉**，
   * 同时把 `currentIndex` 从「原下标」重映射到「可见数组下标」。
   */
  const visibleIndices = computed(() => {
    const source = lyric.displayLines ?? [];
    return source
      .map((line, index) => index)
      .filter((index) => !isLyricLineFiltered(source[index], filterConfig.value));
  });

  const lines = computed(() => {
    const source = lyric.displayLines ?? [];
    return visibleIndices.value.map((index) => source[index]);
  });

  /**
   * 当前行在**可见数组**里的下标。
   *
   * 两步：① 当前行本身被过滤掉时，向前找最近一个可见行（`resolveVisibleLyricIndex`，
   * 内核提供），否则正在唱的那句恰好被过滤时会整页失去高亮；
   * ② 把原下标换成可见数组下标。
   */
  const currentIndex = computed(() => {
    const source = lyric.displayLines ?? [];
    const raw = lyric.currentIndex;
    if (raw < 0 || !source.length) return raw;
    const visibleOriginal = resolveVisibleLyricIndex(source, raw, filterConfig.value);
    if (visibleOriginal < 0) return -1;
    return visibleIndices.value.indexOf(visibleOriginal);
  });

  const isLoading = computed(() => lyric.isLoading);
  /** 无歌词时显示的原因文本（内核给的是人话，如「纯音乐，请欣赏」） */
  const tips = computed(() => lyric.tips || '暂无歌词');
  const hasLines = computed(() => lines.value.length > 0);

  const showTranslation = computed(() => lyric.showTranslation);
  const showRomanization = computed(() => lyric.showRomanization);

  /** 用户在设置里选的字号倍数 + 字重，交给 CSS 变量，避免逐行算样式 */
  const fontScale = computed(() => Number(lyric.fontScale) || 1);
  const fontWeight = computed(() => Number(lyric.fontWeightValue) || 700);

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
    fontScale,
    fontWeight,
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
