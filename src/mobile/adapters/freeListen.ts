/**
 * 随便听频道的数据与「开播」准备。
 *
 * 抽成独立模块是因为它有**两个调用方**，而且其中一个不在页面里：
 *
 * · `FreeListenPage` —— 页面自己加载列表；
 * · 路由守卫 —— 「进入页面时自动播」要在**进入之前**就把播放拉起来，
 *   这样才不用"先渲染列表、等数据回来再跳"（那样的延迟就是用户看到的先闪一下列表）。
 *
 * ⚠️ 守卫在 `router.isReady()` 之前跑，那时可能没有 active pinia，
 * 所以 store 一律显式传 `pinia` 实例。
 */
import { getFreeListenSongs } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import { replaceQueueAndPlay } from '@/utils/playback';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { pinia } from '@mobile/store';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';

/** 本频道的队列标识：增量追加时要用同一个 id */
export const FREE_LISTEN_QUEUE = { queueId: 'queue:free-listen', title: '随便听', subtitle: '' };

/** 拉一批（不去重 —— 去重由调用方按自己的 `seenKeys` 处理） */
export const fetchFreeListenSongs = async (): Promise<Song[]> => {
  const payload = await getFreeListenSongs();
  return (extractList(payload) as unknown[]).map((item) => mapTopSong(item));
};

/**
 * 拉起随便听的播放（拉一批 + 从第一首开始放）。
 *
 * 返回是否真的播起来了。失败只记日志、不抛：它的调用方是路由守卫，
 * 那里出错会把导航整个打断（用户连页面都进不去）。
 */
export const startFreeListenPlayback = async (): Promise<boolean> => {
  try {
    const songs = await fetchFreeListenSongs();
    const playable = songs.filter((song) => song?.id && String(song.hash ?? '').trim());
    if (!playable.length) return false;

    const player = usePlayerStore(pinia);
    const playlist = usePlaylistStore(pinia);
    /**
     * options 必须补齐 `type` 与 `dynamic`（与 `adapters/player.ts` 的 playSong 一致）：
     * 只传 { queueId, title } 时落不到"手动快照队列"的语义上。
     */
    const started = await replaceQueueAndPlay(playlist, player, playable, 0, playable[0], {
      queueId: FREE_LISTEN_QUEUE.queueId,
      title: FREE_LISTEN_QUEUE.title,
      subtitle: FREE_LISTEN_QUEUE.subtitle ?? '',
      type: 'manual',
      dynamic: false,
    });
    logger.info('FreeListen', 'Auto start result', {
      started,
      count: playable.length,
      playing: player.isPlaying,
      error: player.lastError ?? null,
    });
    return started;
  } catch (error) {
    logger.warn('FreeListen', 'Start playback failed', error);
    return false;
  }
};

/**
 * 当前是不是"已经排着随便听的**有内容的**队列"。
 *
 * ⚠️ 只看队列 id 不够：`clearPlaybackQueue()` 这类操作会**留住 id 但清空歌曲**
 * （实测踩到 —— 判断为"已经是本队列"于是走续播分支，可队列里一首歌都没有，
 * 结果既不拉新歌也不出声，跳到播放页后是空的）。
 */
export const isFreeListenQueueReady = (): boolean => {
  const playlist = usePlaylistStore(pinia);
  const queue = playlist.activeQueue;
  if (String(queue?.id ?? '') !== FREE_LISTEN_QUEUE.queueId) return false;
  return (queue?.songs?.length ?? 0) > 0;
};

/**
 * 确保随便听的**队列**就绪（**不碰播放状态**）。
 *
 * ## 为什么不再"没在播就续播"
 *
 * 原来是：队列已就绪但暂停中 → `togglePlay()` 续播。于是"用户暂停 → 切走 → 切回来"
 * 会被强行出声 —— 用户要的是回列表看看，不是接着放。
 * 现在只在**队列还没建起来**（`isFreeListenQueueReady()` 为假）时才拉一批，
 * 那时确实没有可播的内容；队列已有内容就原样保留（可能在播、也可能暂停）。
 *
 * 起不起播、要不要改道去播放页，由调用方（路由守卫）自己决定。
 */
export const ensureFreeListenReady = async (): Promise<boolean> => {
  try {
    if (isFreeListenQueueReady()) return true;
    return await startFreeListenPlayback();
  } catch (error) {
    logger.warn('FreeListen', 'Ensure ready failed', error);
    return false;
  }
};
