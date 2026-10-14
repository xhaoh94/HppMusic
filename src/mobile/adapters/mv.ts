/**
 * MV 数据适配。
 *
 * ## 为什么不能直接用内核的 `mapVideoMetaList`
 *
 * 内核的 `mapVideoMeta` 取 hash 的写法是：
 * ```js
 * const hash = readString(record.hash ?? targetHash, targetHash);
 * ```
 * —— 它只认**顶层 `record.hash`**。而 `/kmr/audio/mv` 的响应里根本没有顶层 hash：
 * 每个清晰度各有一个 hash，藏在子对象里：
 * ```
 * mkv:  { sd_hash, qhd_hash }
 * h264: { sd_hash, hd_hash, fhd_hash, qhd_hash, ld_hash }
 * h265: { sd_hash, hd_hash, fhd_hash, qhd_hash }
 * ```
 * 于是 `mapVideoMetaList` 映射出来的每一项 `hash` 都是空串，拿去请求
 * `/video/url?hash=` 只会得到 `error_code 40004`（实测）。
 *
 * 那种"顶层带 hash"的形状来自 `/video/detail` 与 `/video/privilege`
 * （桌面端的 MvDetail 页是从路由参数拿 hash 的，不经过这里），
 * 所以内核 mapper 在本路径上不适用，这里自己按清晰度优先级选。
 */
import type { VideoMeta } from '@/models/video';

/** 选清晰度的优先级：能用 h264 就不用 h265（兼容性），同编码下优先高清晰度 */
const QUALITY_PRIORITY: { container: 'h264' | 'h265' | 'mkv'; key: string; label: string }[] = [
  { container: 'h264', key: 'fhd_hash', label: '1080P' },
  { container: 'h264', key: 'hd_hash', label: '720P' },
  { container: 'h264', key: 'qhd_hash', label: '540P' },
  { container: 'h264', key: 'sd_hash', label: '标清' },
  { container: 'h265', key: 'fhd_hash', label: '1080P HEVC' },
  { container: 'h265', key: 'hd_hash', label: '720P HEVC' },
  { container: 'h265', key: 'sd_hash', label: '标清 HEVC' },
  { container: 'mkv', key: 'qhd_hash', label: '540P' },
  { container: 'mkv', key: 'sd_hash', label: '标清' },
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 补齐图片 URL 的 `{size}` 占位符（上游所有图片都带这个占位符） */
const withSize = (url: string, size = 480): string =>
  url ? url.replace('{size}', String(size)).replace(/^http:\/\//, 'https://') : '';

/**
 * `/kmr/audio/mv` 的响应是**嵌套数组**：`data: [[{...}]]`。
 * 这里把那一层剥掉；同时容忍上游偶尔返回单层数组。
 */
const flattenRecords = (payload: unknown): Record<string, unknown>[] => {
  const root = asRecord(payload);
  const data = root?.data ?? payload;
  if (!Array.isArray(data)) return [];
  const first = data[0];
  const inner = Array.isArray(first) ? first : data;
  return inner
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
};

export interface MvEntry {
  videoId: string;
  title: string;
  artist: string;
  cover: string;
  /** 已选定的清晰度 hash */
  hash: string;
  /** 清晰度标签，显示给用户 */
  quality: string;
  /** 时长（毫秒）。上游给的是 1/100 秒，这里换算过 */
  durationMs: number;
}

const pickHash = (
  record: Record<string, unknown>,
): { hash: string; quality: string } => {
  for (const { container, key, label } of QUALITY_PRIORITY) {
    const group = asRecord(record[container]);
    const hash = text(group?.[key]);
    if (hash) return { hash, quality: label };
  }
  return { hash: '', quality: '' };
};

export const listMvEntries = (payload: unknown): MvEntry[] =>
  flattenRecords(payload)
    .map((record) => {
      const { hash, quality } = pickHash(record);
      if (!hash) return null;
      const authors = Array.isArray(record.authors) ? record.authors : [];
      const firstAuthor = asRecord(authors[0]);
      const artist =
        text(record.singer) || text(firstAuthor?.author_name) || text(record.user_name);
      // duration 的单位就是**毫秒**（实测 17400 → 视频实际时长 17.4 秒）
      const rawDuration = Number(record.duration ?? 0);
      return {
        videoId: text(record.video_id) || hash,
        title: text(record.mv_name) || text(record.songname) || 'MV',
        artist,
        cover: withSize(text(record.hdpic) || text(record.thumb)),
        hash,
        quality,
        durationMs: Number.isFinite(rawDuration) ? rawDuration : 0,
      } satisfies MvEntry;
    })
    .filter((item): item is MvEntry => item !== null);

/** 兼容内核形态的返回类型（有些地方需要 VideoMeta） */
export type { VideoMeta };
