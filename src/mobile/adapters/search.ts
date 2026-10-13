/**
 * 搜索适配层。
 *
 * 职责边界：
 * · **抽响应**：KuGou 的搜索接口把结果放在 `data.lists`（有时是 `data.list`），
 *   总数在 `data.total/count/counts`；不同 type 的返回层级还不完全一致。
 *   这层把这些差异收敛掉，页面只看到 `{ items, total }`。
 * · **映射**：调内核 mappers 把原始条目变成 `Song` / `PlaylistMeta` /
 *   `AlbumMeta` / `ArtistMeta`。
 * · **分页**：暴露 hasMore 的判定。
 *
 * 上游把同样的逻辑放在 `views/search/searchHelpers.ts` 里（桌面 UI 层，未 vendor）。
 * 那份代码里还有 MV、猜你想搜等本阶段用不到的部分，这里只实现当前需要的分支 ——
 * 其余等对应功能接入时再加，避免又出现"能点但没实现"的入口。
 */
import type { Song } from '@/models/song';
import type { PlaylistMeta } from '@/models/playlist';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import { search, getSearchHot } from '@/api/search';
import { mapSearchSong } from '@/utils/mappers/song';
import { mapPlaylistMeta, mapAlbumMeta, mapArtistMeta } from '@/utils/mappers/playlist';

/* ────────────────────────────────────────────────────────────
   标签页
   ──────────────────────────────────────────────────────────── */

/** 上游的搜索类型标识（`/search?type=`） */
export type SearchTabType = 'song' | 'special' | 'album' | 'author' | 'lyric';

export interface SearchTab {
  type: SearchTabType;
  /** 界面上的短标签 */
  label: string;
  /** 空结果时的说明，避免用户以为是加载失败 */
  emptyHint: string;
}

/**
 * 只登记**已实现**的标签。
 * 上游还有 'mv'，那是 P4 的 MV 播放能力，现在放上来只会点进去一片空白。
 */
export const SEARCH_TABS: readonly SearchTab[] = [
  { type: 'song', label: '单曲', emptyHint: '没有找到相关歌曲' },
  { type: 'special', label: '歌单', emptyHint: '没有找到相关歌单' },
  { type: 'album', label: '专辑', emptyHint: '没有找到相关专辑' },
  { type: 'author', label: '歌手', emptyHint: '没有找到相关歌手' },
  { type: 'lyric', label: '歌词', emptyHint: '没有找到带歌词的歌曲' },
];

export const SEARCH_PAGE_SIZE = 30;

/* ────────────────────────────────────────────────────────────
   响应抽取
   ──────────────────────────────────────────────────────────── */

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const extractLists = (payload: unknown): unknown[] => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const lists = data?.lists ?? data?.list ?? record?.lists ?? record?.list;
  return Array.isArray(lists) ? lists : [];
};

const extractTotal = (payload: unknown): number | null => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const candidates = [data?.total, data?.totalCount, data?.count, data?.counts, record?.total];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

/* ────────────────────────────────────────────────────────────
   结果类型
   ──────────────────────────────────────────────────────────── */

export interface SearchSongItem {
  kind: 'song';
  song: Song;
}
export interface SearchPlaylistItem {
  kind: 'playlist';
  playlist: PlaylistMeta;
  /**
   * 打开歌单详情用的 id。
   *
   * ⚠️ **不是** `playlist.id`（那是数字 specialid）。内核的 `getPlaylistDetail`
   * 与 `getPlaylistTracks` 打的是 `/v3/get_list_info` 与
   * `/pubsongs/v2/get_other_list_file_nofilt`，两者要的都是
   * **`global_collection_id`**（形如 `collection_3_2132029040_287_0`）。
   * 传数字 id 的后果是：详情返回空 `data`、歌曲接口返回
   * `20010 get other list file fail`（字面意思就是“取别人的歌单失败”）。
   * `mapPlaylistMeta` 已经把 global_collection_id / gid / specialid 依次回退好了。
   */
  routeId: string;
}
export interface SearchAlbumItem {
  kind: 'album';
  album: AlbumMeta;
  id: string;
}
export interface SearchArtistItem {
  kind: 'artist';
  artist: ArtistMeta;
  id: string;
}

export type SearchItem =
  | SearchSongItem
  | SearchPlaylistItem
  | SearchAlbumItem
  | SearchArtistItem;

/** 页面展示所需的统一视图模型：一张卡/一行需要的东西都在这 */
export interface SearchItemView {
  /** 列表渲染的 key */
  key: string;
  item: SearchItem;
}

const mapItems = (type: SearchTabType, lists: unknown[]): SearchItemView[] => {
  if (type === 'song' || type === 'lyric') {
    return lists.map((entry, index) => {
      const song = mapSearchSong(entry);
      return {
        key: `song-${song.id || song.hash || index}`,
        item: { kind: 'song', song } as SearchItem,
      };
    });
  }
  if (type === 'special') {
    return lists.map((entry, index) => {
      const playlist = mapPlaylistMeta(entry);
      return {
        key: `playlist-${playlist.id ?? index}`,
        item: {
          kind: 'playlist',
          playlist,
          routeId: playlist.globalCollectionId || String(playlist.id ?? index),
        } as SearchItem,
      };
    });
  }
  if (type === 'album') {
    return lists.map((entry, index) => {
      const album = mapAlbumMeta(entry);
      return {
        key: `album-${album.id ?? index}`,
        item: { kind: 'album', album, id: String(album.id ?? index) } as SearchItem,
      };
    });
  }
  return lists.map((entry, index) => {
    const artist = mapArtistMeta(entry);
    return {
      key: `artist-${artist.id ?? index}`,
      item: { kind: 'artist', artist, id: String(artist.id ?? index) } as SearchItem,
    };
  });
};

/* ────────────────────────────────────────────────────────────
   对外接口
   ──────────────────────────────────────────────────────────── */

export interface SearchPageResult {
  items: SearchItemView[];
  total: number | null;
  /** 是否还有下一页（total 拿不到时退回"本页是否装够"） */
  hasMore: boolean;
}

export const searchByType = async (
  keywords: string,
  type: SearchTabType,
  page = 1,
): Promise<SearchPageResult> => {
  const response = await search(keywords, type, page, SEARCH_PAGE_SIZE);
  const lists = extractLists(response);
  const total = extractTotal(response);
  const items = mapItems(type, lists);
  const hasMore =
    items.length > 0 && (total !== null ? page * SEARCH_PAGE_SIZE < total : items.length >= SEARCH_PAGE_SIZE);
  return { items, total, hasMore };
};

/* ────────────────────────────────────────────────────────────
   热搜
   ──────────────────────────────────────────────────────────── */

export interface HotKeyword {
  keyword: string;
  reason: string;
}
export interface HotCategory {
  name: string;
  keywords: HotKeyword[];
}

/**
 * 热搜分类。
 *
 * 手机上一屏放不下 30 条热词（上游会返回 "热搜榜/飙升榜/DJ榜/外语热搜/…" 好几个分类），
 * 所以默认只取第一个分类的前 N 条 —— 这与前身项目在移动端做的裁剪是同一个决定，
 * 而且当时的注释写明了「剪数据而不是剪 CSS」，因为那个列表是 `grid-auto-flow: column`，
 * 改 `grid-template-rows` 会连带改变列数把文字挤成竖排。
 */
export const getHotCategories = async (limitPerCategory = 9): Promise<HotCategory[]> => {
  const response = await getSearchHot();
  const record = toRecord(response);
  const data = toRecord(record?.data);
  const list = Array.isArray(data?.list) ? data.list : [];

  return list
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const rawKeywords = Array.isArray(entry.keywords) ? entry.keywords : [];
      const keywords = rawKeywords
        .map((item) => toRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({
          keyword: String(item.keyword ?? '').trim(),
          reason: String(item.reason ?? '').trim(),
        }))
        .filter((item) => item.keyword.length > 0)
        .slice(0, limitPerCategory);
      return { name: String(entry.name ?? '').trim(), keywords };
    })
    .filter((category) => category.name.length > 0 && category.keywords.length > 0);
};
