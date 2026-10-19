/**
 * 随便听频道的数据。
 *
 * 「开播/自动改道播放页」那套逻辑已随守卫一起移除（用户要求：
 * 播放页只从底部中间按钮进），现在这个模块只剩数据获取。
 */
import { getFreeListenSongs } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { mapTopSong } from '@/utils/mappers';
import type { Song } from '@/models/song';

/** 本频道的队列标识：增量追加时要用同一个 id */
export const FREE_LISTEN_QUEUE = { queueId: 'queue:free-listen', title: '随便听', subtitle: '' };

/** 拉一批（不去重 —— 去重由调用方按自己的 `seenKeys` 处理） */
export const fetchFreeListenSongs = async (): Promise<Song[]> => {
  const payload = await getFreeListenSongs();
  return (extractList(payload) as unknown[]).map((item) => mapTopSong(item));
};
