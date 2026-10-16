/**
 * 「当前正在播放的是哪一首」——列表标记与自动定位共用这一份判断。
 *
 * 为什么不各页面自己写：判断规则只有一条（拿当前曲目的定位键比），但要用在
 * 六七个列表页里，各写一遍必然漂移。这里统一提供：
 * · `useCurrentSongKey` —— 当前曲目的定位键（SongRow 的 data-song-key 同规则）
 * · `useLocatePlayingSong` —— 列表首次有内容时，把那一行滚到视口中间
 */
import { nextTick, ref, watch, type Ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { songKeyOf } from '@mobile/utils/songKey';
import type { Song } from '@/models/song';

/** 当前播放曲目的定位键；没在播放时是空串。 */
export const useCurrentSongKey = (): { currentSongKey: Ref<string> } => {
  const player = usePlayerStore();
  const currentSongKey = ref('');
  watch(
    () => player.currentTrackSnapshot as Song | null,
    (snapshot) => {
      currentSongKey.value = songKeyOf(snapshot);
    },
    { immediate: true },
  );
  return { currentSongKey };
};

/**
 * 首次打开列表时，把"正在播放"那一行滚到视口中间。
 *
 * 语义是**首次**：列表从空变非空时只做一次，用户手动滚走后再回来不该被强行拽回去
 * （页签切走再切回有 KeepAlive 保状态，也不会重复触发）。换批/换歌单属于组件重挂载
 * 或列表替换，各自重新计数。
 *
 * 找不到那一行（当前歌不在这个列表里）也算用掉这次机会 —— 否则预取追加后可能
 * 在用户正浏览时突然滚一下。
 */
export const useLocatePlayingSong = (
  list: Ref<readonly unknown[]>,
  currentKey: Ref<string>,
) => {
  let located = false;
  watch(
    [list, currentKey],
    ([items, key]) => {
      if (located || !key || items.length === 0) return;
      located = true;
      // 等一帧：列表刚渲染完才能查到那一行
      nextTick(() => {
        requestAnimationFrame(() => {
          const row = document.querySelector(`[data-song-key="${CSS.escape(key)}"]`);
          row?.scrollIntoView({ block: 'center' });
        });
      });
    },
    { immediate: true },
  );
};
