import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    moveToBackground: vi.fn(),
    downloadApk: vi.fn(async () => ({ id: 7 })),
    queryDownload: vi.fn(),
    installApk: vi.fn(async () => ({ started: true })),
  }),
}));

import { formatBytes, mapRelease, pickApkAsset } from '../src/mobile/adapters/appUpdate';

const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'v0.2.0',
  body: '  修复若干问题  ',
  html_url: 'https://github.com/xhaoh94/HppMusic/releases/tag/v0.2.0',
  published_at: '2026-10-17T10:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'HppMusic-0.2.0-debug.apk', size: 8_000_000, browser_download_url: 'https://e/apk' },
    { name: 'checksums.txt', size: 100, browser_download_url: 'https://e/txt' },
  ],
  ...overrides,
});

describe('更新发布信息', () => {
  it('只挑 apk，多个时取体积最大的', () => {
    expect(
      pickApkAsset([
        { name: 'a.apk', size: 10, browser_download_url: 'https://a' },
        { name: 'b.apk', size: 99, browser_download_url: 'https://b' },
        { name: 'c.zip', size: 999, browser_download_url: 'https://c' },
      ]),
    ).toEqual({ url: 'https://b', size: 99 });
    expect(pickApkAsset([])).toBeNull();
    expect(pickApkAsset(null)).toBeNull();
  });

  it('映射版本号、说明与大小，并去掉 v 前缀', () => {
    expect(mapRelease(release())).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      notes: '修复若干问题',
      apkUrl: 'https://e/apk',
      size: 8_000_000,
    });
  });

  it('没有 APK 资产的发布不算更新', () => {
    expect(mapRelease(release({ assets: [] }))).toBeNull();
    expect(mapRelease(release({ tag_name: '' }))).toBeNull();
  });

  it('配置代理时给下载与发布页地址加前缀', () => {
    const mapped = mapRelease(release(), { proxyUrl: 'https://proxy.example/' });
    expect(mapped?.apkUrl).toBe('https://proxy.example/https://e/apk');
    expect(mapped?.pageUrl.startsWith('https://proxy.example/https://github.com')).toBe(true);
  });

  it('文件大小显示', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0MB');
  });
});
