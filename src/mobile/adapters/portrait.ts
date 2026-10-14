/**
 * 写真（歌手图片）的获取与轮播。
 *
 * 上游把这段逻辑放在 `composables/useLyricPortrait.ts`（桌面 UI 层，未 vendor），
 * 这里按同样的接口语义自建一版，但**只保留移动端需要的部分**：
 * 取图、缓存、轮播、预解码。上游那份还带着桌面皮肤/背景联动，那些在手机上没有对应物。
 *
 * 取图规则（与上游一致，不要自己改优先级）：
 * `getAudioImages` 返回 `authors[].imgs`，按类型分组。类型 `3` / `4` / `2` 是
 * 可用的写真尺寸档，**按 3 > 4 > 2 试，哪一档有数据就用整档**；
 * 混着取会让同一个歌手的不同图片清晰度/裁切比例不一致。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { Song } from '@/models/song';
import { getAudioImages } from '@/api/music';
import logger from '@/utils/logger';

/** 尺寸档优先级 */
const PORTRAIT_TYPE_PRIORITY = ['3', '4', '2'] as const;
/** 有结果缓存 30 分钟；空结果只缓存 5 分钟（可能只是这次接口抽风） */
const CACHE_TTL_HIT = 30 * 60 * 1000;
const CACHE_TTL_EMPTY = 5 * 60 * 1000;
const CACHE_MAX = 40;

interface CacheEntry {
  urls: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<string[]>>();

const normalizeUrl = (url: unknown): string =>
  String(url ?? '')
    .trim()
    // 上游图片全是 http，WebView 里混合内容会被拦；页面本身是 https
    .replace(/^http:\/\//, 'https://');

const readPortraits = (authors: unknown): string[] => {
  if (!Array.isArray(authors)) return [];
  for (const type of PORTRAIT_TYPE_PRIORITY) {
    const urls = new Set<string>();
    for (const author of authors as { imgs?: Record<string, unknown> }[]) {
      const list = author?.imgs?.[type];
      if (!Array.isArray(list)) continue;
      for (const item of list as { sizable_portrait?: string }[]) {
        const url = normalizeUrl(item?.sizable_portrait);
        if (url) urls.add(url);
      }
    }
    if (urls.size > 0) return [...urls];
  }
  return [];
};

const fetchPortraits = async (track: Song): Promise<string[]> => {
  const hash = String(track.hash || '').trim();
  if (!hash) return [];

  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.urls;
  const inflight = pending.get(hash);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const response: any = await getAudioImages({
        hash,
        // `Song` 上没有 audioId（只有 CloudAudioSource 有），
        // 写真接口能接受的就是 albumAudioId / filename 这两个补充线索
        albumAudioId: track.albumAudioId as string | number | undefined,
        filename: track.title,
        count: 10,
      });
      const urls = readPortraits(response?.data?.authors);
      cache.set(hash, {
        urls,
        expiresAt: Date.now() + (urls.length ? CACHE_TTL_HIT : CACHE_TTL_EMPTY),
      });
      // 简单裁剪：Map 保持插入序，删最旧的几个即可
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return urls;
    } catch (error) {
      logger.warn('Portrait', 'Load artist portraits failed', error);
      cache.set(hash, { urls: [], expiresAt: Date.now() + CACHE_TTL_EMPTY });
      return [];
    } finally {
      pending.delete(hash);
    }
  })();

  pending.set(hash, request);
  return request;
};

/** 预解码：切图时不做同步解码，否则会卡一帧 */
const preDecode = (url: string) => {
  if (!url) return;
  const image = new Image();
  image.src = url;
  void image.decode?.().catch(() => undefined);
};

export interface UsePortraitOptions {
  /** 是否轮播（来自设置的 lyricCarouselEnabled） */
  carouselEnabled: Ref<boolean>;
  /** 轮播间隔秒（来自设置的 lyricCarouselInterval） */
  carouselInterval: Ref<number>;
}

export const useArtistPortraits = (
  track: Ref<Song | null>,
  options: UsePortraitOptions,
) => {
  const urls = ref<string[]>([]);
  const index = ref(0);
  const loading = ref(false);

  let timer: number | null = null;

  const currentUrl = computed(() => urls.value[index.value] ?? '');
  const hasImages = computed(() => urls.value.length > 0);

  const clearTimer = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    clearTimer();
    if (!options.carouselEnabled.value) return;
    if (urls.value.length < 2) return;
    // 间隔下限 5 秒：再短会像幻灯片，且每张都要下载
    const seconds = Math.max(5, Number(options.carouselInterval.value) || 15);
    timer = window.setInterval(() => {
      if (urls.value.length < 2) return;
      index.value = (index.value + 1) % urls.value.length;
      const next = urls.value[(index.value + 1) % urls.value.length];
      if (next) preDecode(next);
    }, seconds * 1000);
  };

  const load = async () => {
    const current = track.value;
    clearTimer();
    urls.value = [];
    index.value = 0;
    if (!current) return;

    loading.value = true;
    try {
      const result = await fetchPortraits(current);
      // 期间切歌了就丢弃（track 变了）
      if (track.value !== current) return;
      urls.value = result;
      index.value = 0;
      if (result[1]) preDecode(result[1]);
      startTimer();
    } finally {
      if (track.value === current) loading.value = false;
    }
  };

  watch(track, () => void load(), { immediate: true });
  watch([options.carouselEnabled, options.carouselInterval], () => startTimer());

  onBeforeUnmount(clearTimer);

  return { urls, index, currentUrl, hasImages, loading, reload: load };
};
