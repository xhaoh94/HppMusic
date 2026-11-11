import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge/polyfills', () => ({}));
vi.mock('@shared/apiRequestMerge', () => ({ mergeApiRequestBody: vi.fn() }));
vi.mock('@/generated/kugou-api.js', () => ({
  modules: {
    '/slow': () => new Promise(() => {}),
    '/ok': async () => ({ status: 200, body: { ok: true } }),
  },
  util: { createRequest: vi.fn(), applyCliOverrides: vi.fn() },
}));
vi.mock('../src/bridge/deviceIdentity', () => ({
  getDeviceIdentity: () => ({ mid: 'm', guid: 'g', mac: '00', webglHash: 'w' }),
}));
vi.mock('../src/bridge/nativePlayer', () => ({
  createNativePlayerBridge: () => ({ player: {}, mediaControls: {} }),
}));
vi.mock('../src/bridge/deviceApis', () => ({ createCloudApi: () => ({}), createRecognizeApi: () => ({}) }));
vi.mock('../src/bridge/shareApi', () => ({ createNativeShareApi: () => ({}) }));
vi.mock('../src/bridge/externalApi', () => ({ createExternalApi: () => ({}) }));
vi.mock('../src/bridge/backupApis', () => ({ createSettingsBackupApi: () => ({}) }));
vi.mock('../src/bridge/audioEffects', () => ({ createAudioEffectsApi: () => ({}) }));
vi.mock('../src/bridge/runtimeApis', () => ({
  createApiServerApi: () => ({}),
  createAppInfoApi: () => ({}),
  createIpcRendererApi: () => ({}),
  createLogApi: () => ({}),
  createNetworkApi: () => ({}),
  createStorageApi: () => ({}),
  createWindowControlApi: () => ({}),
}));

import { handleApiRequest, initApiBridge, withRequestTimeout } from '../src/bridge/apiBridge';
import { createPlayerState } from '../src/renderer/stores/player/state';
import { shouldRetryFailedPlayback } from '../src/renderer/stores/player/stateMachine';

describe('取链请求超时', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    initApiBridge();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Promise 永不 settle 时 15s 后返回 504，不再永久挂住', async () => {
    const request = handleApiRequest({ method: 'GET', url: '/slow' });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(request).resolves.toMatchObject({ status: 504 });
  });

  it('二进制请求体（听歌识曲）放宽到 30s，不在 15s 处误杀', async () => {
    const request = handleApiRequest({
      method: 'POST',
      url: '/slow',
      data: new Uint8Array([1, 2, 3]),
    });
    let settled = false;
    void request.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(request).resolves.toMatchObject({ status: 504 });
  });

  it('正常响应不受超时影响', async () => {
    await expect(handleApiRequest({ method: 'GET', url: '/ok' })).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
  });

  it('withRequestTimeout 在任务先完成时清理定时器', async () => {
    await expect(withRequestTimeout(Promise.resolve('done'), 100)).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('网络恢复重试的判定', () => {
  it('只认失败态，用户主动暂停与加载中不重试', () => {
    const state = createPlayerState();
    state.currentTrackId = 'a';
    expect(shouldRetryFailedPlayback(state)).toBe(false);

    state.playbackIntent.phase = 'ready';
    expect(shouldRetryFailedPlayback(state)).toBe(false);

    state.playbackIntent.phase = 'loading';
    expect(shouldRetryFailedPlayback(state)).toBe(false);

    state.playbackIntent.phase = 'failed';
    expect(shouldRetryFailedPlayback(state)).toBe(true);

    state.currentTrackId = null;
    expect(shouldRetryFailedPlayback(state)).toBe(false);
  });
});
