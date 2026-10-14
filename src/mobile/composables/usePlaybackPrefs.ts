/**
 * 移动端自己的「跳播放页」偏好。
 *
 * ## 为什么不放进内核的 setting store
 *
 * `src/renderer/**` 是**只读 vendor**，会被 `sync-upstream` 全量覆盖 ——
 * 往里加字段下次同步就没了。所以移动端特有的偏好自己存，
 * 与 `design/theme.ts`、`shell/useHomeTabs.ts` 同一套做法：
 * `localStorage` + 模块级单例（所有调用方共享同一份，改一处全站生效）。
 *
 * ## 两个开关是独立的
 *
 * 它们是**两种不同的意图**，不该合并：
 * · 「进入页面时自动播」—— 进来就是"开始听"，所以自动放第一首并打开播放页；
 * · 「点歌后进播放页」—— 在列表里挑歌，挑了就走。
 *
 * 默认都关：进页面就开始出声、或者点一下就离开列表，都属于"用户没要求却发生"的行为，
 * 不该默认打开（要留给用户自己选）。
 */
import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'hppmusic:playback-prefs';

interface PlaybackPrefs {
  /** 切入歌曲列表页时：自动播放第一首并进入全屏播放页 */
  autoPlayAndOpen: boolean;
  /** 在列表里点某一首之后：进入全屏播放页 */
  openOnSelect: boolean;
}

const DEFAULTS: PlaybackPrefs = { autoPlayAndOpen: false, openOnSelect: false };

const read = (): PlaybackPrefs => {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PlaybackPrefs>;
    return {
      autoPlayAndOpen: raw.autoPlayAndOpen === true,
      openOnSelect: raw.openOnSelect === true,
    };
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

/** 切入歌曲列表页时，自动播放第一首并打开播放页 */
export const autoPlayAndOpenOnEnter = computed({
  get: () => prefs.value.autoPlayAndOpen,
  set: (value: boolean) => {
    prefs.value = { ...prefs.value, autoPlayAndOpen: value };
  },
});

/** 在列表里点某一首之后，打开播放页 */
export const openPlayerOnSelect = computed({
  get: () => prefs.value.openOnSelect,
  set: (value: boolean) => {
    prefs.value = { ...prefs.value, openOnSelect: value };
  },
});
