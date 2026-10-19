import { computed, onScopeDispose, ref, watch } from 'vue';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
import { usePlaybackActions } from '@mobile/adapters/player';

export type PersonalFmLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 同一个 playlist store 的预览请求只允许在途一份。
 * key 包含账号会话，切账号后不会错误复用旧账号的 Promise。
 */
const previewRequests = new WeakMap<object, { key: string; promise: Promise<Song[]> }>();

const sessionKeyOf = (user: {
  isLoggedIn: boolean;
  accountRevision: number;
  info: { userid?: string | number; userId?: string | number; token?: string } | null;
}) =>
  [
    user.isLoggedIn ? '1' : '0',
    String(user.accountRevision),
    String(user.info?.userid ?? user.info?.userId ?? ''),
    String(user.info?.token ?? ''),
  ].join('|');

/**
 * 判断是否已经存在真实 FM 播放会话。
 *
 * 这里不能只看 playlistStore.activeQueue：预览不会激活队列，而持久化队列也可能
 * 只是历史数据。只有播放器当前确实从 FM 队列取曲目时，页面才跳过预览刷新，避免
 * 用一批新预览覆盖正在播放会话的 buffer。
 */
const hasRealFmSession = (player: ReturnType<typeof usePlayerStore>) =>
  String(player.currentSourceQueueId ?? '') === PERSONAL_FM_QUEUE_ID &&
  Boolean(player.currentTrackId || player.currentTrackSnapshot);

export const usePersonalFm = () => {
  const player = usePlayerStore();
  const playlist = usePlaylistStore();
  const user = useUserStore();
  const playback = usePlaybackActions();

  const state = ref<PersonalFmLoadState>('idle');
  const error = ref('');
  const acceptedSessionKey = ref(sessionKeyOf(user));
  const dataSessionKey = ref<string | null>(null);
  let generation = 0;
  let disposed = false;

  const currentSessionKey = computed(() => sessionKeyOf(user));
  const sessionIsVisible = () =>
    !disposed &&
    user.isLoggedIn &&
    acceptedSessionKey.value === currentSessionKey.value &&
    dataSessionKey.value === currentSessionKey.value;

  const previewTrack = computed<Song | null>(() => {
    if (!sessionIsVisible()) return null;
    return playlist.getPersonalFmPreviewTrack() as Song | null;
  });

  const displayTracks = computed<Song[]>(() => {
    if (!sessionIsVisible()) return [];
    return playlist.getPersonalFmDisplayTracks(5) as Song[];
  });

  const isPlaying = computed(
    () =>
      String(player.currentSourceQueueId ?? '') === PERSONAL_FM_QUEUE_ID &&
      Boolean(player.isPlaying),
  );

  const hasFmSession = computed(() => hasRealFmSession(player));
  const isFavorite = computed(() => {
    const track = previewTrack.value;
    return Boolean(track && playlist.isFavoriteSong(track));
  });

  const load = async (options?: { force?: boolean }): Promise<boolean> => {
    if (!user.isLoggedIn || disposed) return false;

    const requestGeneration = ++generation;
    const requestSessionKey = currentSessionKey.value;
    const isSessionCurrent = captureUserSession(user);
    acceptedSessionKey.value = requestSessionKey;
    error.value = '';

    // 已经在播的真实会话优先：切入页签只读取内核队列，不请求新预览。
    if (hasRealFmSession(player)) {
      dataSessionKey.value = requestSessionKey;
      state.value = 'ready';
      return true;
    }

    if (!options?.force && dataSessionKey.value === requestSessionKey && previewTrack.value) {
      state.value = 'ready';
      return true;
    }

    state.value = 'loading';
    try {
      let promise = previewRequests.get(playlist)?.promise;
      const pending = previewRequests.get(playlist);
      if (!promise || pending?.key !== requestSessionKey) {
        promise = playlist.refreshPersonalFmPreview(undefined, { throwOnError: true });
        previewRequests.set(playlist, { key: requestSessionKey, promise });
        void promise.then(
          () => {
            if (previewRequests.get(playlist)?.promise === promise) previewRequests.delete(playlist);
          },
          () => {
            if (previewRequests.get(playlist)?.promise === promise) previewRequests.delete(playlist);
          },
        );
      }

      await promise;
      if (
        disposed ||
        requestGeneration !== generation ||
        !isSessionCurrent() ||
        requestSessionKey !== currentSessionKey.value
      ) {
        return false;
      }
      dataSessionKey.value = requestSessionKey;
      state.value = 'ready';
      return true;
    } catch (cause) {
      if (
        disposed ||
        requestGeneration !== generation ||
        !isSessionCurrent() ||
        requestSessionKey !== currentSessionKey.value
      ) {
        return false;
      }
      state.value = 'error';
      error.value = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  };

  const runPlayerAction = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (!sessionIsVisible()) return false;
    const isSessionCurrent = captureUserSession(user);
    await action();
    return !disposed && isSessionCurrent() && sessionIsVisible();
  };

  /** 只有用户显式点击开始或列表曲目时才会调用内核起播。 */
  const play = (track?: Song | null) =>
    runPlayerAction(() => player.playPersonalFmTrack(track ?? undefined));

  const togglePlay = () => {
    if (!sessionIsVisible()) return Promise.resolve(false);
    if (!hasFmSession.value) return play(previewTrack.value);
    return runPlayerAction(() => player.togglePlay());
  };

  const next = () => {
    if (!hasFmSession.value) return Promise.resolve(false);
    return runPlayerAction(() => player.next());
  };

  const dislike = () => {
    if (!hasFmSession.value) return Promise.resolve(false);
    return runPlayerAction(() => player.dislikePersonalFm());
  };

  /** 收藏统一走 usePlaybackActions，不能在 FM 页面自己改 favorites 或歌单。 */
  const toggleFavorite = async (track: Song = previewTrack.value as Song) => {
    if (!track || !sessionIsVisible()) return Promise.resolve(false);
    const isSessionCurrent = captureUserSession(user);
    const changed = await playback.toggleFavorite(track);
    return !disposed && isSessionCurrent() && sessionIsVisible() ? changed : false;
  };

  // 账号切换/退出登录时，旧页面数据立即失效；在途响应即使回来也不能写回页面状态。
  watch(currentSessionKey, (next) => {
    if (next === acceptedSessionKey.value) return;

    // 账号切换时只停止正在播的 FM；普通队列继续由播放器自己维持。
    // removePersonalFmQueue 会清空 FM buffer 并递增 FM epoch，使旧账号的在途请求、
    // advance/feedback 上报全部失效；KeepAlive 页面也因此不会把旧 buffer 交给新账号。
    if (hasRealFmSession(player)) player.stop();
    playlist.removePersonalFmQueue();

    acceptedSessionKey.value = next;
    dataSessionKey.value = null;
    generation += 1;
    error.value = '';
    state.value = 'idle';
    if (user.isLoggedIn) void load();
  });

  onScopeDispose(() => {
    disposed = true;
    generation += 1;
  });

  return {
    state,
    error,
    isLoggedIn: computed(() => user.isLoggedIn),
    previewTrack,
    displayTracks,
    isPlaying,
    hasFmSession,
    isFavorite,
    load,
    play,
    togglePlay,
    next,
    dislike,
    toggleFavorite,
  };
};

/** 语义化别名，页面和测试可按「适配器」命名使用。 */
export const usePersonalFmAdapter = usePersonalFm;
