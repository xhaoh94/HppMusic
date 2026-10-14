/**
 * 歌曲的「定位键」。
 *
 * 用途：把列表里的某一行与**当前正在播放**的那首歌对上，从而支持
 * 「定位到当前播放」。`SongRow` 会把它写到 DOM 的 `data-song-key` 上，
 * 调用方只需 `querySelector` 就能找到那一行，不必为每个列表维护元素引用。
 *
 * ## 为什么按这个顺序取
 *
 * `mixSongId` → `hash` → `id`，与内核判断"是不是同一首歌"的规则一致。
 * 只比 `id` 会漏：收藏列表与播放队列可能来自不同接口，同一个 `id` 未必指同一首
 * （反过来，不同接口给的 `id` 也可能不一样）。
 */
import type { Song } from '@/models/song';

export const songKeyOf = (song: Song | null | undefined): string =>
  String(song?.mixSongId ?? song?.hash ?? song?.id ?? '').trim();
