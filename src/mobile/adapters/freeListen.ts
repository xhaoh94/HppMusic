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
 * 确保随便听在放。
 *
 * 两种情形：
 * · 队列已经是随便听的**且有歌** —— 那就不该重新拉（否则每次切页签都换一批歌），
 *   但它可能只是**暂停着**（用户从播放页暂停后退出去），所以要续播；
 * · 否则拉一批从第一首开播。
 *
 * 先写成"只在不是本队列时才拉"，结果第二种情形漏了 —— 跳到播放页后是暂停状态，
 * 看着像没生效。
 */
export const ensureFreeListenPlaying = async (): Promise<boolean> => {
  try {
    const player = usePlayerStore(pinia);
    if (isFreeListenQueueReady()) {
      if (!player.isPlaying) await player.togglePlay();
      return true;
    }
    return await startFreeListenPlayback();
  } catch (error) {
    logger.warn('FreeListen', 'Ensure playing failed', error);
    return false;
  }
};
