import { describe, expect, it, vi } from 'vitest';
import { createNativePlaybackReconciler, nativeSnapshotTrackId } from '../src/shared/nativePlaybackSnapshot';

vi.mock('@/utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/utils/player', () => ({ normalizePlayerErrorPayload: vi.fn() }));
vi.mock('@/utils/song', () => ({ isPlayableSong: () => true }));
vi.mock('../src/renderer/stores/playlist', () => ({ DISCOVER_QUEUE_ID: 'discover', PERSONAL_FM_QUEUE_ID: 'fm' }));
vi.mock('../src/renderer/stores/toast', () => ({ useToastStore: vi.fn() }));
vi.mock('../src/renderer/stores/historyStore', () => ({ useHistoryStore: () => ({ recordPlay: vi.fn() }) }));
vi.mock('../src/renderer/stores/player/utils', () => ({
  buildMediaMeta: vi.fn(), buildMediaState: vi.fn(), buildStoppedPlaybackState: vi.fn(),
  clampNumber: vi.fn(), findPlayableIndex: vi.fn(), findTrackById: vi.fn(),
}));
vi.mock('../src/renderer/stores/playlist/helpers', () => ({
  toRawSong: (song: object) => ({ ...song }), toRawSongList: (songs: object[]) => songs.slice(),
}));

import { createPlaybackManager } from '../src/renderer/stores/player/playback';
import { createPlayerState } from '../src/renderer/stores/player/state';
import { nativeQueueMode, nativeQueueCandidateIndices } from '../src/shared/nativeQueueMode';
import { createAudioManager } from '../src/renderer/stores/player/audio';

const snapshot = (id = 'c', paused = false) => ({
  trackId: id, mediaId: `hppmusic-background-next:${id}`, path: `https://audio/${id}`,
  playing: !paused, paused, playWhenReady: !paused, ended: false,
  duration: 240, timePos: 87.25, trackSeq: 5, sampledAt: 1000,
  backgroundQueueActive: true,
});

function fixture() {
  const songs: NonNullable<ReturnType<typeof createPlayerState>['currentPlaylist']> = ['a', 'b', 'c'].map(id => ({
    id, title: id, name: id, artist: '', album: '', hash: id, duration: 240,
    coverUrl: '', audioUrl: `https://audio/${id}`, mixSongId: id,
  }));
  const state = createPlayerState();
  Object.assign(state, {
    currentTrackId: 'a', currentSourceQueueId: 'queue', currentPlaylist: songs,
    currentTrackSnapshot: songs[0], nativeTrackSeq: 1,
  });
  const engine = {
    adoptNativePlaybackSnapshot: vi.fn(), beginSourceChange: vi.fn(), setSource: vi.fn(),
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setLoopFile: vi.fn(),
    updateMediaMetadata: vi.fn(), clearBackgroundQueue: vi.fn(),
    supportsNativePlaybackQueue: vi.fn(() => true), getNativeQueueGeneration: vi.fn(async () => 2),
    setBackgroundRepeatMode: vi.fn(), setBackgroundNextSource: vi.fn(), skipNativeQueueTrack: vi.fn(async () => true),
    finishNativeQueuePreparation: vi.fn(),
  };
  const playlist = {
    playbackQueues: [{ id: 'queue', songs }], updateQueueCurrentTrack: vi.fn(),
    consumeQueuedNextTrackId: vi.fn(), syncQueuedNextTrackIds: vi.fn(),
  };
  const lyrics = { clear: vi.fn(), setLyric: vi.fn(), fetchLyrics: vi.fn() };
  const resolver = { resolveAudioUrl: vi.fn() };
  const manager = createPlaybackManager(
    state, engine as any, playlist as any, {} as any, lyrics, resolver,
    { resetHistoryUploadState: vi.fn() }, vi.fn(), vi.fn(),
  );
  const assertNoTransport = () => {
    for (const [key, method] of Object.entries(engine)) {
      if (key !== 'adoptNativePlaybackSnapshot') expect(method, key).not.toHaveBeenCalled();
    }
    expect(resolver.resolveAudioUrl).not.toHaveBeenCalled();
  };
  return { state, manager, engine, playlist, lyrics, resolver, assertNoTransport };
}

describe('原生播放恢复：只同步，不重演切歌', () => {
  it('跨多首直接接收当前曲目，保留 87.25 秒的播放进度', () => {
    const f = fixture();
    expect(f.manager.adoptNativePlaybackSnapshot(snapshot())).toBe(true);
    expect(f.state.currentTrackId).toBe('c');
    expect(f.state.currentTime).toBe(87.25);
    expect(f.state.nativeTrackSeq).toBe(5);
    expect(f.state.currentAudioUrl).toBe('https://audio/c');
    expect(f.engine.adoptNativePlaybackSnapshot).toHaveBeenCalledWith('https://audio/c', 87.25, 240, 1000);
    f.assertNoTransport();
  });

  it('暂停状态返回前台，不自动播放；重复恢复不重复拉歌词', () => {
    const f = fixture();
    f.manager.adoptNativePlaybackSnapshot(snapshot('b', true));
    f.manager.adoptNativePlaybackSnapshot(snapshot('b', true));
    expect(f.state.playbackIntent.shouldPlay).toBe(false);
    expect(f.state.enginePlayback.status).toBe('paused');
    expect(f.lyrics.fetchLyrics).toHaveBeenCalledTimes(1);
    f.assertNoTransport();
  });

  it('随机播放或上一首落点直接同步，循环回初始项无需 next 追赶', () => {
    const f = fixture();
    f.state.playMode = 'random';
    f.state.shuffleQueue = [1, 2];
    f.manager.adoptNativePlaybackSnapshot(snapshot('c'));
    f.manager.adoptNativePlaybackSnapshot({ ...snapshot('a'), mediaId: 'hppmusic-1' });
    expect(f.state.currentTrackId).toBe('a');
    expect(f.state.currentTime).toBe(87.25);
    expect(f.state.shuffleQueue).not.toContain(2);
    f.assertNoTransport();
  });

  it('队尾结束只同步 stopped，不重新开始下一轮播放', () => {
    const f = fixture();
    f.manager.adoptNativePlaybackSnapshot({ ...snapshot(), ended: true, playing: false, timePos: 240 });
    expect(f.state.playbackEnded).toBe(true);
    expect(f.state.playbackIntent.shouldPlay).toBe(false);
    f.assertNoTransport();
  });

  it('切换时原生时长尚未就绪，保留曲目时长以免进度条归零', () => {
    const f = fixture();
    f.manager.adoptNativePlaybackSnapshot({ ...snapshot(), duration: 0 });
    expect(f.state.duration).toBe(240);
    expect(f.engine.adoptNativePlaybackSnapshot).toHaveBeenCalledWith('https://audio/c', 87.25, 240, 1000);
    f.assertNoTransport();
  });

  it('原生清队列尚未完成时重复触发准备，只进行一次清理', async () => {
    const f = fixture();
    let finish!: () => void;
    f.state.enginePlayback.status = 'playing';
    f.state.playbackIntent.shouldPlay = true;
    f.state.playbackIntent.phase = 'ready';
    f.engine.clearBackgroundQueue.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = f.manager.prepareBackgroundNext();
    await Promise.resolve();
    await f.manager.prepareBackgroundNext();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);
    // 模拟准备期间用户选中其他歌曲，旧任务必须退出，不能追加过期地址。
    f.state.playbackRequestSeq += 1;
    finish();
    await first;
    expect(f.resolver.resolveAudioUrl).not.toHaveBeenCalled();
  });

  it('未知歌曲和正在加载时不猜测目标、不强行重开音源', () => {
    const f = fixture();
    expect(f.manager.adoptNativePlaybackSnapshot(snapshot('missing'))).toBe(false);
    f.state.awaitingTrackLoad = true;
    expect(f.manager.adoptNativePlaybackSnapshot(snapshot())).toBe(false);
    expect(f.state.currentTrackId).toBe('a');
    f.assertNoTransport();
  });
});

describe('原生队列的播放模式', () => {
  it.each([
    ['sequential', 0], ['single', 1], ['list', 2], ['random', 3],
  ] as const)('%s 正确映射，并为所有模式准备同一完整队列', async (mode, expected) => {
    expect(nativeQueueMode(mode)).toBe(expected);
    const f = fixture();
    f.state.playMode = mode;
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.setBackgroundRepeatMode).toHaveBeenCalledWith(expected);
    const entries = f.engine.setBackgroundNextSource.mock.calls.map(([entry]) => entry);
    expect(entries.map(entry => entry.trackId)).toEqual(['b', 'c']);
    expect(entries.map(entry => entry.queueIndex)).toEqual([1, 2]);
    expect(entries.every(entry => entry.currentQueueIndex === 0 && entry.generation === 2)).toBe(true);
    expect(f.engine.setSource).not.toHaveBeenCalled();
    expect(f.engine.play).not.toHaveBeenCalled();
  });

  it('从列表中间开始仍传真实索引，优先准备后续，再补前半列表', () => {
    expect(nativeQueueCandidateIndices(5, 2)).toEqual([3, 4, 0, 1]);
    expect(nativeQueueCandidateIndices(1, 0)).toEqual([]);
    expect(nativeQueueCandidateIndices(0, -1)).toEqual([]);
  });

  it('只剩当前一首也应用循环，不为单曲再复制一份音源', async () => {
    const f = fixture();
    f.state.currentPlaylist!.splice(1);
    f.state.playMode = 'single';
    await f.manager.prepareBackgroundNext();
    expect(f.engine.setBackgroundRepeatMode).toHaveBeenCalledWith(1);
    expect(f.engine.setBackgroundNextSource).not.toHaveBeenCalled();
    expect(f.resolver.resolveAudioUrl).not.toHaveBeenCalled();
  });

  it('切换模式不会用 setLoopFile(false) 覆盖原生模式，也不重复取链', async () => {
    const f = fixture();
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    const audio = createAudioManager(f.state, f.engine as any, vi.fn(), {} as any);
    audio.setPlayMode('random');
    await f.manager.prepareBackgroundNext();
    audio.setPlayMode('single');
    await f.manager.prepareBackgroundNext();
    expect(f.engine.setLoopFile).not.toHaveBeenCalled();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);
    expect(f.resolver.resolveAudioUrl).toHaveBeenCalledTimes(2);
  });

  it('前台上下首使用原生队列，不再重新 load/play', async () => {
    const f = fixture();
    await f.manager.next();
    await f.manager.prev();
    expect(f.engine.skipNativeQueueTrack.mock.calls).toEqual([[1], [-1]]);
    expect(f.engine.setSource).not.toHaveBeenCalled();
    expect(f.engine.play).not.toHaveBeenCalled();
    expect(f.resolver.resolveAudioUrl).not.toHaveBeenCalled();
  });

  it('取链全失败后退避重试，不永久锁死，也不每个进度事件重复请求', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = fixture();
      f.resolver.resolveAudioUrl.mockResolvedValue({ url: '' });
      await f.manager.prepareBackgroundNext();
      await f.manager.prepareBackgroundNext();
      expect(f.resolver.resolveAudioUrl).toHaveBeenCalledTimes(2);
      expect(f.engine.clearBackgroundQueue).toHaveBeenCalledWith(3);
      clock.mockReturnValue(31_001);
      f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
      await f.manager.prepareBackgroundNext();
      expect(f.engine.setBackgroundNextSource).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('取链期间换歌，旧响应不追加到新队列', async () => {
    const f = fixture();
    let finish!: (value: { url: string }) => void;
    f.resolver.resolveAudioUrl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const task = f.manager.prepareBackgroundNext();
    await vi.waitFor(() => expect(f.resolver.resolveAudioUrl).toHaveBeenCalledOnce());
    f.state.playbackRequestSeq++;
    finish({ url: 'https://audio/stale' });
    await task;
    expect(f.engine.setBackgroundNextSource).not.toHaveBeenCalled();
  });
});

describe('私人FM原生推荐缓冲', () => {
  it('普通模式即使是列表循环，FM也准备buffer而不是循环已听历史', async () => {
    const f = fixture();
    const list = f.state.currentPlaylist!;
    f.state.currentSourceQueueId = 'fm';
    f.playlist.playbackQueues[0].id = 'fm';
    f.playlist.playbackQueues[0].songs = list.slice(0, 1);
    Object.assign(f.playlist, { personalFmBuffer: list.slice(1), personalFmSessionEpoch: 0 });
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.setBackgroundRepeatMode).toHaveBeenCalledWith(0);
    expect(f.engine.setBackgroundNextSource.mock.calls.map(([item]) => item.trackId)).toEqual(['b', 'c']);
    await f.manager.prepareBackgroundNext();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);
  });

  it.each(['b', 'c'])('原生跨曲恢复到 %s，消费经过的buffer并只追加新推荐', async (target) => {
    const f = fixture();
    const list = f.state.currentPlaylist!;
    const queue = f.playlist.playbackQueues[0];
    f.state.currentSourceQueueId = 'fm';
    queue.id = 'fm';
    queue.songs = list.slice(0, 1);
    const q: any = f.playlist;
    q.personalFmSessionEpoch = 0;
    q.personalFmBuffer = list.slice(1);
    q.peekNextPersonalFmCandidate = vi.fn((_id, occurrence, track) => ({ track, occurrence, origin: 'buffer' }));
    q.commitPersonalFmCandidate = vi.fn(({ track }) => {
      q.personalFmBuffer = q.personalFmBuffer.filter((item: any) => item.id !== track.id);
      queue.songs.push(track);
      return queue.songs;
    });
    q.reportPersonalFmAdvance = vi.fn();
    q.replenishPersonalFmBuffer = vi.fn(async () => {
      q.personalFmBuffer.push({ ...list[0], id: 'd', hash: 'd' });
      return 1;
    });
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    expect(f.manager.adoptNativePlaybackSnapshot(snapshot(target))).toBe(true);
    expect(f.state.currentTrackId).toBe(target);
    expect(f.state.currentTime).toBe(87.25);
    expect(q.personalFmBuffer.some((song: any) => song.id === 'b')).toBe(false);
    expect(queue.songs.some((song) => song.id === 'b')).toBe(true);
    await vi.waitFor(() => expect(f.engine.setBackgroundNextSource).toHaveBeenCalledTimes(3));
    expect(f.engine.setBackgroundNextSource.mock.calls[2][0]).toMatchObject({ trackId: 'd', append: true });
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);
    expect(f.engine.setSource).not.toHaveBeenCalled();
    expect(f.engine.play).not.toHaveBeenCalled();
  });
});

describe('前台恢复并发和过期快照', () => {
  it('visibility/focus/pageshow 合并读取；读取期间用户换歌或 seek 后丢弃旧快照', async () => {
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    let revision = 'before';
    const read = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(resolve => { finish = resolve; }));
    const apply = vi.fn();
    const reconcile = createNativePlaybackReconciler({ read, apply, captureRevision: () => revision });
    const first = reconcile();
    expect(reconcile()).toBe(first);
    expect(reconcile()).toBe(first);
    revision = 'user-selected-another-track';
    finish(snapshot());
    await first;
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    const second = reconcile();
    finish(snapshot('b'));
    await second;
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('先采用原生落点，再处理未执行的用户命令，不能从旧曲目 next', async () => {
    const steps: string[] = [];
    const reconcile = createNativePlaybackReconciler({
      read: async () => snapshot('c'), captureRevision: () => 'same',
      apply: native => { steps.push(`adopt:${native.trackId}`); },
      afterApply: async () => { steps.push('pending-user-command'); },
    });
    await reconcile();
    expect(steps).toEqual(['adopt:c', 'pending-user-command']);
  });

  it('读取失败后可以重试', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('bridge')).mockResolvedValue(snapshot());
    const apply = vi.fn();
    const reconcile = createNativePlaybackReconciler({ read, apply, captureRevision: () => 'same' });
    await expect(reconcile()).rejects.toThrow('bridge');
    await reconcile();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('初始曲目使用业务 ID，兼容已有前缀 ID，但不猜测 hppmusic-序号', () => {
    expect(nativeSnapshotTrackId({ ...snapshot('a'), mediaId: 'hppmusic-1' })).toBe('a');
    expect(nativeSnapshotTrackId({ ...snapshot('c'), trackId: undefined })).toBe('c');
    expect(nativeSnapshotTrackId({ ...snapshot(), trackId: undefined, mediaId: 'hppmusic-1' })).toBe('');
  });
});
