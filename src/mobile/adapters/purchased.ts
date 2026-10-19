/**
 * 已购音乐适配层。
 *
 * server/module/user_purchased_{songs,albums}.js 只是把分页参数转给酷狗版权接口：
 * · 单曲：/openapi/copyright/v1/audio/get_goods
 * · 专辑：/openapi/v1/copyright/get_album_goods
 * 酷狗两个接口的列表字段并不完全一致，因此页面不直接读取响应，而是在这里统一
 * 抽取、映射、去重并计算分页状态。
 */
import { getPurchasedAlbum, getPurchasedSongs } from '@/api/purchased';
import type { AlbumMeta } from '@/models/album';
import type { Song } from '@/models/song';
import { mapAlbumMeta } from '@/utils/mappers/playlist';
import { mapTopSong } from '@/utils/mappers/song';

export const PURCHASED_PAGE_SIZE = 30;

export interface PurchasedPage<T> {
  items: T[];
  total: number | null;
  hasMore: boolean;
}

type RecordLike = Record<string, unknown>;

const asRecord = (value: unknown): RecordLike | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstNumber = (records: readonly RecordLike[], keys: readonly string[]): number | null => {
  for (const record of records) {
    for (const key of keys) {
      const value = asNumber(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

/** 在 root/data/info/result 以及 goods/list 的嵌套容器中找数组。 */
const extractArray = (payload: unknown, keys: readonly string[]): unknown[] => {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (!root) return [];

  const queue: RecordLike[] = [root];
  const visited = new Set<RecordLike>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const key of keys) {
      const value = current[key];
      if (Array.isArray(value)) return value;
    }

    for (const key of [
      'data',
      'info',
      'result',
      'goods',
      'goods_info',
      'audio',
      'albums',
      'album_info',
      'payload',
    ]) {
      const nested = asRecord(current[key]);
      if (nested) queue.push(nested);
    }
  }
  return [];
};

const recordsForMetadata = (payload: unknown): RecordLike[] => {
  const root = asRecord(payload);
  if (!root) return [];
  const records: RecordLike[] = [root];
  const queue: RecordLike[] = [root];
  const visited = new Set<RecordLike>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const key of ['data', 'info', 'result', 'goods', 'goods_info', 'payload']) {
      const nested = asRecord(current[key]);
      if (nested) {
        records.push(nested);
        queue.push(nested);
      }
    }
  }
  return records;
};

const readExplicitHasMore = (records: readonly RecordLike[]): boolean | null => {
  for (const record of records) {
    for (const key of ['has_more', 'hasMore', 'more']) {
      const value = record[key];
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1') return true;
      if (value === 0 || value === '0') return false;
    }
    for (const key of ['is_end', 'isEnd']) {
      const value = record[key];
      if (value === true || value === 1 || value === '1') return false;
      if (value === false || value === 0 || value === '0') return true;
    }
  }
  return null;
};

/**
 * 总条数。
 *
 * ⚠️ 只认明确表达“总数”的字段：`count` / `num` 在酷狗这些容器里通常是
 * **本页返回条数**，当成总数会让分页在第一页就判定“没有更多”（同时页面还显示
 * “30 首”）。拿不到总数时交给本页长度兜底（见 buildPage）。
 */
const pageTotal = (payload: unknown): number | null => {
  const total = firstNumber(recordsForMetadata(payload), ['total', 'total_count', 'totalCount']);
  if (total !== null && total > 0) return total;
  return null;
};

const hasFailedStatus = (payload: unknown): boolean => {
  const root = asRecord(payload);
  return root?.status === 0 || root?.status === '0';
};

const responseError = (payload: unknown, fallback: string): Error => {
  const records = recordsForMetadata(payload);
  for (const record of records) {
    for (const key of ['message', 'msg', 'error', 'err_msg', 'error_msg']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return new Error(value.trim());
    }
  }
  return new Error(fallback);
};

const songItems = (payload: unknown) =>
  extractArray(payload, [
    'list',
    'lists',
    'goods',
    'goods_list',
    'audio_list',
    'audio',
    'song_list',
    'songlist',
    'songs',
    'items',
    'records',
    'data',
  ]);

const albumItems = (payload: unknown) =>
  extractArray(payload, [
    'list',
    'lists',
    'album_list',
    'albumList',
    'albums',
    'album_goods',
    'goods',
    'goods_list',
    'items',
    'records',
    'data',
  ]);

export const mapPurchasedSong = (value: unknown): Song => mapTopSong(value);

export const mapPurchasedAlbum = (value: unknown): AlbumMeta => mapAlbumMeta(value);

/**
 * 单曲去重键。
 *
 * ⚠️ 绝不能返回空串：`dedupe` 会把空 key 当作“无法识别”直接 `continue`，
 * 于是上游缺 hash/id 的条目会被**静默丢掉**（用户看到已购列表少了几首，却没有任何提示）。
 * 所以逐级回退到「歌名+歌手」、「行号」，至少保证条目还在。
 */
export const purchasedSongKey = (song: Song, index = -1): string => {
  const stable = String(song.mixSongId || song.hash || song.songId || song.id || '').trim();
  if (stable && stable !== '0') return `id:${stable}`;
  const soft = [song.name || song.title, song.artist, song.albumName || song.album]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\u0000');
  return soft ? `soft:${soft}` : `row:${index}`;
};

/**
 * 专辑去重键。
 *
 * `mapAlbumMeta` 缺 id 时会补成 `0`（falsy），旧实现直接拼 `${id}\u0000${name}\u0000${singer}`，
 * 缺元数据时得到同一个 `"undefined\u0000undefined"` → 多张专辑被合并成一条。
 * 这里把 id=0 当作“没有 id”，再回退到名称/行号。
 */
export const purchasedAlbumKey = (album: AlbumMeta, index = -1): string => {
  const id = String(album.id || album.albumid || album.album_id || '').trim();
  if (id && id !== '0') return `id:${id}`;
  const soft = [album.name, album.singerName]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\u0000');
  return soft ? `soft:${soft}` : `row:${index}`;
};

const dedupe = <T>(items: readonly T[], keyOf: (item: T, index: number) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const [index, item] of items.entries()) {
    const key = keyOf(item, index);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

export const dedupePurchasedSongs = (songs: readonly Song[]): Song[] =>
  dedupe(songs, purchasedSongKey);

export const dedupePurchasedAlbums = (albums: readonly AlbumMeta[]): AlbumMeta[] =>
  dedupe(albums, purchasedAlbumKey);

export const extractPurchasedSongs = (payload: unknown): Song[] =>
  dedupePurchasedSongs(songItems(payload).map(mapPurchasedSong));

export const extractPurchasedAlbums = (payload: unknown): AlbumMeta[] =>
  dedupePurchasedAlbums(albumItems(payload).map(mapPurchasedAlbum));

const buildPage = <T>(
  payload: unknown,
  rawLength: number,
  items: T[],
  page: number,
): PurchasedPage<T> => {
  const total = pageTotal(payload);
  const explicitHasMore = readExplicitHasMore(recordsForMetadata(payload));
  const hasMore =
    explicitHasMore ??
    (total !== null ? page * PURCHASED_PAGE_SIZE < total : rawLength >= PURCHASED_PAGE_SIZE);
  // total/has_more 是服务端对分页边界的判断；即使本页为空，也不能据此提前终止。
  // 页面会在空态关闭自动哨兵，只允许用户手动继续请求下一页，避免空页自动死循环。
  return { items, total, hasMore };
};

export const getPurchasedSongsPage = async (page = 1): Promise<PurchasedPage<Song>> => {
  const response = await getPurchasedSongs(page, PURCHASED_PAGE_SIZE);
  if (hasFailedStatus(response)) throw responseError(response, '已购单曲加载失败');
  const raw = songItems(response);
  return buildPage(response, raw.length, extractPurchasedSongs(response), page);
};

export const getPurchasedAlbumsPage = async (page = 1): Promise<PurchasedPage<AlbumMeta>> => {
  const response = await getPurchasedAlbum(page, PURCHASED_PAGE_SIZE);
  if (hasFailedStatus(response)) throw responseError(response, '已购专辑加载失败');
  const raw = albumItems(response);
  return buildPage(response, raw.length, extractPurchasedAlbums(response), page);
};

// 与其它移动端适配层的命名保持兼容：调用方可把它们当作“取一页”的 loader。
export const fetchPurchasedSongsPage = getPurchasedSongsPage;
export const fetchPurchasedAlbumsPage = getPurchasedAlbumsPage;
