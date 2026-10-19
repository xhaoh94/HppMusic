/**
 * 移动端自己的播放偏好。
 *
 * ## 为什么不放进内核的 setting store
 *
 * `src/renderer/**` 是**只读 vendor**，会被 `sync-upstream` 全量覆盖 ——
 * 往里加字段下次同步就没了。所以移动端特有的偏好自己存，
 * 与 `design/theme.ts`、`shell/useHomeTabs.ts` 同一套做法：
 * `localStorage` + 模块级单例（所有调用方共享同一份，改一处全站生效）。
 */
import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'hppmusic:playback-prefs';

interface PlaybackPrefs {
  /** 与其他音源同时播放：不申请音频焦点，别的 App 抢焦点也不暂停 */
  coPlayWithOthers: boolean;
}

const DEFAULTS: PlaybackPrefs = { coPlayWithOthers: false };

const read = (): PlaybackPrefs => {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PlaybackPrefs>;
    return { coPlayWithOthers: raw.coPlayWithOthers === true };
  } catch {
    // 存储坏了就退回默认值，不要让设置页打不开
    return { ...DEFAULTS };
  }
};

const prefs = ref<PlaybackPrefs>(read());

watch(
  prefs,
  (value) => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  },
  { deep: true },
);

/** 与其他音源同时播放（设置页 → 播放）。改动会实时下发到原生。 */
export const coPlayWithOthers = computed({
  get: () => prefs.value.coPlayWithOthers,
  set: (value: boolean) => {
    prefs.value = { ...prefs.value, coPlayWithOthers: value };
  },
});
