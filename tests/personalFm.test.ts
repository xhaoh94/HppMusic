import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, type EffectScope } from 'vue';

const mocks = vi.hoisted(() => {
  const track = {
    id: 'fm-1',
    title: 'FM 歌曲',
    artist: 'FM 歌手',
    coverUrl: 'https://image/fm-1.jpg',
    cover: '',
    duration: 180,
    audioUrl: '',
    hash: 'hash-fm-1',
    mixSongId: 'mix-fm-1',
  };
  const user = {
    isLoggedIn: true,
    accountRevision: 1,
    info: { userid: 7, token: 'token-1' },
  };
  const player = {
    currentSourceQueueId: '',
    currentTrackId: null as string | null,
    currentTrackSnapshot: null as unknown,
    isPlaying: false,
    playPersonalFmTrack: vi.fn().mockResolvedValue(undefined),
    dislikePersonalFm: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    togglePlay: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
  const playlist = {
    preview: track as typeof track | null,
    refreshPersonalFmPreview: vi.fn().mockResolvedValue([track]),
    getPersonalFmPreviewTrack: vi.fn(() => playlist.preview),
    getPersonalFmDisplayTracks: vi.fn(() => (playlist.preview ? [playlist.preview] : [])),
    isFavoriteSong: vi.fn(() => false),
    removePersonalFmQueue: vi.fn(),
  };
  const playback = {
    toggleFavorite: vi.fn().mockResolvedValue(true),
  };
  return { track, user, player, playlist, playback };
});

vi.mock('@/stores/player', () => ({ usePlayerStore: () => mocks.player }));
vi.mock('@/stores/playlist', () => ({
  PERSONAL_FM_QUEUE_ID: 'queue:personal-fm',
  usePlaylistStore: () => mocks.playlist,
}));
vi.mock('@/stores/user', async () => {
  const { reactive } = await import('vue');
  const store = reactive(mocks.user);
  return { useUserStore: () => store };
});

import { useUserStore } from '@/stores/user';
vi.mock('@mobile/adapters/player', () => ({
  usePlaybackActions: () => mocks.playback,
}));

import { usePersonalFm } from '../src/mobile/adapters/personalFm';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let scopes: EffectScope[] = [];

const setup = () => {
  const scope = effectScope();
  scopes.push(scope);
  const adapter = scope.run(() => usePersonalFm())!;
  return { scope, adapter };
};

beforeEach(() => {
  mocks.user.isLoggedIn = true;
  mocks.user.accountRevision = 1;
  mocks.user.info = { userid: 7, token: 'token-1' };
  mocks.player.currentSourceQueueId = '';
  mocks.player.currentTrackId = null;
  mocks.player.currentTrackSnapshot = null;
  mocks.player.isPlaying = false;
  mocks.playlist.preview = mocks.track;
  mocks.playlist.refreshPersonalFmPreview.mockReset().mockResolvedValue([mocks.track]);
  mocks.playlist.getPersonalFmPreviewTrack.mockClear();
  mocks.playlist.getPersonalFmDisplayTracks.mockClear();
  mocks.playlist.isFavoriteSong.mockClear().mockReturnValue(false);
  mocks.playback.toggleFavorite.mockReset().mockResolvedValue(true);
  mocks.player.playPersonalFmTrack.mockReset().mockResolvedValue(undefined);
  mocks.player.dislikePersonalFm.mockReset().mockResolvedValue(undefined);
  mocks.player.next.mockReset().mockResolvedValue(undefined);
  mocks.player.togglePlay.mockReset().mockResolvedValue(undefined);
  mocks.player.stop.mockReset().mockImplementation(() => {
    mocks.player.currentSourceQueueId = '';
    mocks.player.currentTrackId = null;
    mocks.player.currentTrackSnapshot = null;
    mocks.player.isPlaying = false;
  });
  mocks.playlist.removePersonalFmQueue.mockReset();
});

afterEach(() => {
  scopes.forEach((scope) => scope.stop());
  scopes = [];
});

describe('私人 FM 适配层', () => {
  it('相同账号的预览请求去重，并只更新预览不触碰播放器', async () => {
    const pending = deferred<typeof mocks.track[]>();
    mocks.playlist.refreshPersonalFmPreview.mockReturnValue(pending.promise);
    const { adapter } = setup();

    const first = adapter.load();
    const second = adapter.load();
    expect(mocks.playlist.refreshPersonalFmPreview).toHaveBeenCalledTimes(1);
    expect(mocks.player.playPersonalFmTrack).not.toHaveBeenCalled();

    pending.resolve([mocks.track]);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(adapter.previewTrack.value).toBe(mocks.track);
    expect(adapter.state.value).toBe('ready');
  });

  it('底层真实拒绝会进入错误态，而不是被空数组吞掉', async () => {
    mocks.playlist.refreshPersonalFmPreview.mockRejectedValueOnce(new Error('FM 请求被拒绝'));
    const { adapter } = setup();

    await expect(adapter.load()).resolves.toBe(false);
    expect(adapter.state.value).toBe('error');
    expect(adapter.error.value).toBe('FM 请求被拒绝');
    expect(mocks.playlist.refreshPersonalFmPreview).toHaveBeenCalledExactlyOnceWith(
      undefined,
      { throwOnError: true },
    );
  });

  it('已有真实 FM 播放会话优先，不刷新 buffer 也不抢当前队列', async () => {
    mocks.player.currentSourceQueueId = 'queue:personal-fm';
    mocks.player.currentTrackId = 'fm-1';
    mocks.player.currentTrackSnapshot = mocks.track;
    mocks.player.isPlaying = true;
    const { adapter } = setup();

    await expect(adapter.load()).resolves.toBe(true);
    expect(mocks.playlist.refreshPersonalFmPreview).not.toHaveBeenCalled();
    expect(adapter.hasFmSession.value).toBe(true);
    expect(adapter.isPlaying.value).toBe(true);
  });

  it('开始、下一首、不喜欢使用原生 FM 动作，收藏复用 usePlaybackActions', async () => {
    const { adapter } = setup();
    await adapter.load();

    await expect(adapter.play()).resolves.toBe(true);
    expect(mocks.player.playPersonalFmTrack).toHaveBeenCalledExactlyOnceWith(undefined);

    mocks.player.currentSourceQueueId = 'queue:personal-fm';
    mocks.player.currentTrackId = 'fm-1';
    mocks.player.currentTrackSnapshot = mocks.track;
    await expect(adapter.next()).resolves.toBe(true);
    await expect(adapter.dislike()).resolves.toBe(true);
    expect(mocks.player.next).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.player.dislikePersonalFm).toHaveBeenCalledExactlyOnceWith();

    await expect(adapter.toggleFavorite()).resolves.toBe(true);
    expect(mocks.playback.toggleFavorite).toHaveBeenCalledExactlyOnceWith(mocks.track);
  });

  it('账号变化时只停止并清理 FM，不影响普通队列', async () => {
    const { adapter } = setup();
    await adapter.load();
    mocks.player.currentSourceQueueId = 'queue:personal-fm';
    mocks.player.currentTrackId = 'fm-1';
    mocks.player.currentTrackSnapshot = mocks.track;
    mocks.player.isPlaying = true;

    const userStore = useUserStore();
    userStore.accountRevision = 2;
    userStore.info = { userid: 8, token: 'token-2' };
    await nextTick();

    expect(mocks.player.stop).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.playlist.removePersonalFmQueue).toHaveBeenCalledExactlyOnceWith();

    mocks.player.stop.mockClear();
    mocks.playlist.removePersonalFmQueue.mockClear();
    mocks.player.currentSourceQueueId = 'queue:manual';
    mocks.player.currentTrackId = 'manual-1';
    mocks.player.currentTrackSnapshot = mocks.track;
    userStore.accountRevision = 3;
    userStore.info = { userid: 9, token: 'token-3' };
    await nextTick();

    expect(mocks.player.stop).not.toHaveBeenCalled();
    expect(mocks.playlist.removePersonalFmQueue).toHaveBeenCalledExactlyOnceWith();
  });

  it('账号变化或卸载后，旧请求结果不再写回适配层', async () => {
    const pending = deferred<typeof mocks.track[]>();
    mocks.playlist.refreshPersonalFmPreview.mockReturnValue(pending.promise);
    const { adapter, scope } = setup();
    const loading = adapter.load();

    mocks.user.accountRevision = 2;
    mocks.user.info = { userid: 8, token: 'token-2' };
    await nextTick();
    pending.resolve([mocks.track]);
    await expect(loading).resolves.toBe(false);
    // 即使旧请求回来，关键断言是旧响应不能暴露为当前账号数据。
    expect(adapter.previewTrack.value).toBeNull();

    const second = adapter.load();
    scope.stop();
    await expect(second).resolves.toBe(false);
    expect(adapter.previewTrack.value).toBeNull();
  });
});
