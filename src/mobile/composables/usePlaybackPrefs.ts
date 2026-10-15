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
 * 默认：「进入页面时自动播」开（进频道即听，是产品要的行为），
 * 「点歌后进播放页」关（点一下就离开列表属于"用户没要求却发生"，留给用户自己选）。
 */
import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'hppmusic:playback-prefs';

interface PlaybackPrefs {
  /** 切入歌曲列表页时：自动播放第一首并进入全屏播放页 */
  autoPlayAndOpen: boolean;
  /** 在列表里点某一首之后：进入全屏播放页 */
  openOnSelect: boolean;
}

const DEFAULTS: PlaybackPrefs = { autoPlayAndOpen: true, openOnSelect: false };

const read = (): PlaybackPrefs => {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PlaybackPrefs>;
    return {
      // 与 openOnSelect 不同：这一项**缺省即开**。老存储里没有这个字段、
      // 或者首次运行，都要落到默认值 true；只有用户明确关过（存了 false）才关。
      autoPlayAndOpen: raw.autoPlayAndOpen !== false,
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

/**
 * 「本次会话是不是**第一次**进入歌曲列表页」。
 *
 * ## 它只决定一件事：要不要"接着放"
 *
 * 跳不跳播放页跟它无关 —— 那是**每次**进入都做的（用户要的就是"进频道就回播放页"）。
 * 它管的只是：队列已就绪、但处于暂停态时，该不该自动续播。
 *
 * · 冷启动从 storage 恢复出来的队列通常就是暂停态，这时进频道确实是想听 —— 该接着放；
 * · 但用户**自己按过暂停**后切走再切回来，"没在播"同样成立，
 *   此时续播就是把人家刚按下的暂停顶掉，会变成"停不下来"。
 *
 * 这两种情形在状态上完全一样，只能靠"是不是第一次进入"区分。
 *
 * 名额是模块级变量，进程重启即归还；用户重新打开开关时也会归还（见下面 set 里的说明）。
 */
let firstEntryConsumed = false;

/** 认领"本次会话第一次进入"这个事实。返回 true 表示这就是第一次。 */
export const claimFirstEntry = (): boolean => {
  if (firstEntryConsumed) return false;
  firstEntryConsumed = true;
  return true;
};

/** 切入歌曲列表页时，自动播放第一首并打开播放页（**仅本次会话首次**） */
export const autoPlayAndOpenOnEnter = computed({
  get: () => prefs.value.autoPlayAndOpen,
  set: (value: boolean) => {
    /**
     * 重新打开开关 = 用户又想要这个行为，把名额还回去。
     * 不还的话：用户关掉试一下、再打开，会发现"怎么没反应了" —— 名额在第一次就用掉了。
     */
    if (value) firstEntryConsumed = false;
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
