import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let data: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  data = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('主页新增页签', () => {
  it('保留用户原有三个页签，允许继续添加私人FM和已购音乐', async () => {
    data.set('hpp.homeTabs', JSON.stringify(['home', 'free-listen', 'listen-together']));
    const tabs = await import('../src/mobile/shell/useHomeTabs');
    expect(tabs.homeTabKeys.value).toEqual(['home', 'free-listen', 'listen-together']);
    expect(tabs.toggleHomeTab('personal-fm')).toBe('');
    expect(tabs.toggleHomeTab('purchased')).toBe('');
    expect(tabs.toggleHomeTab('explore')).toBe('');
    expect(tabs.homeTabs.value.map(item => item.path)).toContain('/main/personal-fm');
    expect(tabs.homeTabs.value.map(item => item.path)).toContain('/main/purchased');
    expect(JSON.parse(data.get('hpp.homeTabs')!)).toHaveLength(6);
  });

  it('不限制页签数量，只过滤无效配置和重复项', async () => {
    data.set('hpp.homeTabs', JSON.stringify(['personal-fm', 'purchased', 'purchased', 'missing']));
    const tabs = await import('../src/mobile/shell/useHomeTabs');
    expect(tabs.homeTabKeys.value).toEqual(['personal-fm', 'purchased']);
    expect(tabs.toggleHomeTab('missing')).not.toBe('');
    tabs.toggleHomeTab('purchased');
    expect(tabs.toggleHomeTab('personal-fm')).not.toBe('');
  });
});
