import { describe, expect, it, vi } from 'vitest';
import { createNativePlaybackReconciler, nativeSnapshotTrackId } from '../src/shared/nativePlaybackSnapshot';

vi.mock('@/utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
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

import { createPlaybackManager, BACKGROUND_QUEUE_AHEAD } from '../src/renderer/stores/player/playback';
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
    debugLog: vi.fn(),
    play: vi.fn(), pause: vi.fn(), setLoopFile: vi.fn(),
    setPlaybackRate: vi.fn(), applyTrackLoudness: vi.fn(), adoptPreparedTrackLoudness: vi.fn(),
    updateMediaMetadata: vi.fn(), clearBackgroundQueue: vi.fn(),
    clearPreparedNextSource: vi.fn(), updateMediaPlaybackState: vi.fn(),
    seek: vi.fn(async () => undefined), reset: vi.fn(),
    supportsNativePlaybackQueue: vi.fn(() => true), getNativeQueueGeneration: vi.fn(async () => 2),
    setBackgroundRepeatMode: vi.fn(), setBackgroundNextSource: vi.fn(), skipNativeQueueTrack: vi.fn(async () => true),
    finishNativeQueuePreparation: vi.fn(),
  };
  const playlist = {
    playbackQueues: [{ id: 'queue', songs }], updateQueueCurrentTrack: vi.fn(),
    consumeQueuedNextTrackId: vi.fn(), consumeQueuedNextTrackIds: vi.fn(),
    syncQueuedNextTrackIds: vi.fn(),
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
    // 随机模式的候选顺序来自 shuffleQueue，显式给一份固定顺序，避免测试依赖 Math.random
    if (mode === 'random') {
      f.state.shuffleQueue = [1, 2];
      f.state.shuffleQueueLength = 3;
    }
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.setBackgroundRepeatMode).toHaveBeenCalledWith(expected);
    const entries = f.engine.setBackgroundNextSource.mock.calls.map(([entry]) => entry);
    // 候选数量 = 预置深度（只影响无缝换曲，不影响切歌）
    expect(entries.map(entry => entry.trackId)).toEqual(['b', 'c'].slice(0, BACKGROUND_QUEUE_AHEAD));
    expect(entries.map(entry => entry.queueIndex)).toEqual([1, 2].slice(0, BACKGROUND_QUEUE_AHEAD));
    expect(entries.every(entry => entry.currentQueueIndex === 0 && entry.generation === 2)).toBe(true);
    expect(f.engine.setSource).not.toHaveBeenCalled();
    expect(f.engine.play).not.toHaveBeenCalled();
  });

  it('随机模式按整列表的乱序取候选，而不是"当前项之后的连续 N 首"', async () => {
    const f = fixture();
    const list = f.state.currentPlaylist!;
    // 补到 20 首，模拟"我喜欢"这种长列表
    for (let index = list.length; index < 20; index += 1) {
      list.push({ ...list[0], id: `s${index}`, hash: `s${index}`, mixSongId: `s${index}` });
    }
    f.state.playMode = 'random';
    f.state.currentTrackId = 'a';
    // 一整轮乱序里最后 4 首（索引 16..19）—— 按列表顺序永远排在第 15 位之后，
    // 原生窗口只有 15 首，取"连续候选"的话它们永远进不了窗口。
    f.state.shuffleQueue = [16, 17, 18, 19];
    f.state.shuffleQueueLength = list.length;
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    const trackIds = f.engine.setBackgroundNextSource.mock.calls.map(([entry]) => entry.trackId);
    expect(trackIds.length).toBeGreaterThan(0);
    // 索引 16~19 在列表顺序里排在最后，取"连续候选"永远轮不到它们
    expect(trackIds[0]).toBe('s16');
    expect(trackIds).not.toContain('s1');
  });

  it('同样的队列用连续候选会漏掉列表后段（对照）', () => {
    // 原生窗口只有少数几首时，从索引 0 开始按列表顺序取只能覆盖 1..N
    expect(nativeQueueCandidateIndices(20, 0).slice(0, 2)).toEqual([1, 2]);
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
    expect(f.resolver.resolveAudioUrl).toHaveBeenCalledTimes(BACKGROUND_QUEUE_AHEAD);
  });

  it('手动上下首走渲染层决策，不再在原生小窗口里 seek', async () => {
    const f = fixture();
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.next();
    expect(f.engine.skipNativeQueueTrack).not.toHaveBeenCalled();
    expect(f.engine.setSource).toHaveBeenCalled();
    expect(f.engine.play).toHaveBeenCalled();
    await f.manager.prev();
    expect(f.engine.skipNativeQueueTrack).not.toHaveBeenCalled();
  });

  it('随机模式手动下一首按整列表乱序推进，不再在原生窗口里挑', async () => {
    const f = fixture();
    const list = f.state.currentPlaylist!;
    for (let index = list.length; index < 20; index += 1) {
      list.push({ ...list[0], id: `s${index}`, hash: `s${index}`, mixSongId: `s${index}` });
    }
    f.state.playMode = 'random';
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));

    // 首次调用会重置并重建乱序轮次（进入随机模式的既定行为），先跑一次让队列就位
    await f.manager.next();
    expect(f.engine.skipNativeQueueTrack).not.toHaveBeenCalled();
    const front = f.state.shuffleQueue![0];
    const expectedId = String(list[front]!.id);

    await f.manager.next();

    // 落点 = 乱序队列的队首（来自整列表，不是当前曲附近的连续几首）
    expect(String(f.state.currentTrackId)).toBe(expectedId);
    // 队首已消费
    expect(f.state.shuffleQueue![0]).not.toBe(front);
  });

  it('原生切歌后重建一轮队列，窗口随当前项前移；同曲恢复不清队列', async () => {
    const f = fixture();
    f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);

    // 同一首的快照（息屏回来 / 多次 tick）不能再清一次队列
    f.manager.adoptNativePlaybackSnapshot(snapshot('a'));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(1);

    // 原生真的切到下一首：窗口必须重建，否则它会在旧的那几首里被
    // REPEAT_MODE_ALL 永远循环（用户报的"随机只在十几首里打转"）
    f.manager.adoptNativePlaybackSnapshot(snapshot('c'));
    await f.manager.prepareBackgroundNext();
    expect(f.engine.clearBackgroundQueue).toHaveBeenCalledTimes(2);
  });

  it('取链全失败后退避重试，不永久锁死，也不每个进度事件重复请求', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = fixture();
      f.resolver.resolveAudioUrl.mockResolvedValue({ url: '' });
      await f.manager.prepareBackgroundNext();
      await f.manager.prepareBackgroundNext();
      expect(f.resolver.resolveAudioUrl).toHaveBeenCalledTimes(BACKGROUND_QUEUE_AHEAD);
      expect(f.engine.clearBackgroundQueue).toHaveBeenCalledWith(BACKGROUND_QUEUE_AHEAD + 1);
      clock.mockReturnValue(31_001);
      f.resolver.resolveAudioUrl.mockImplementation(async (track: { id: string }) => ({ url: `https://audio/${track.id}` }));
      await f.manager.prepareBackgroundNext();
      expect(f.engine.setBackgroundNextSource).toHaveBeenCalledTimes(BACKGROUND_QUEUE_AHEAD);
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
    expect(f.engine.setBackgroundNextSource.mock.calls.map(([item]) => item.trackId))
      .toEqual(['b', 'c'].slice(0, BACKGROUND_QUEUE_AHEAD));
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
    await vi.waitFor(() =>
      expect(f.engine.setBackgroundNextSource).toHaveBeenCalledTimes(BACKGROUND_QUEUE_AHEAD + 1),
    );
    // 追加的是"还没预置过的新推荐"，具体是哪首取决于预置深度，这里只钉住
    // "必须是 append、且不是已预置过的 b"这两个不变量
    const appended = f.engine.setBackgroundNextSource.mock.calls[BACKGROUND_QUEUE_AHEAD][0];
    expect(appended).toMatchObject({ append: true });
    expect(appended.trackId).not.toBe('b');
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

describe('高频 seek 合并', () => {
  it('300ms 内多次 seek 只下发最后一次，中间的直接丢弃', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const f = fixture();
    // seek 会被 clamp 到总时长内，先给一个有效时长
    f.state.duration = 300;
    f.engine.seek.mockResolvedValue(undefined);
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000);
    const first = f.manager.seek(10);
    clock.mockReturnValue(1_050);
    void f.manager.seek(20);
    clock.mockReturnValue(1_100);
    void f.manager.seek(30);
    await first;
    expect(f.engine.seek).toHaveBeenCalledTimes(1);
    expect(f.engine.seek).toHaveBeenLastCalledWith(10);
    // 窗口结束后只补发最后一次目标
    await vi.waitFor(() => expect(f.engine.seek).toHaveBeenCalledTimes(2), { timeout: 1500 });
    expect(f.engine.seek).toHaveBeenLastCalledWith(30);
    clock.mockRestore();
    vi.unstubAllGlobals();
  });
});
