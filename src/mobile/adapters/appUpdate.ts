/**
 * 应用内更新。
 *
 * ## 为什么下载走原生 DownloadManager
 *
 * 更新包几十 MB，用 fetch/XHR 自己下的话：退到后台就容易被系统掐掉，断网后
 * 只能从头再来，还没有任何系统级提示。走 `DownloadManager` 换来三件事：
 * **断点续传**（网络恢复自动接着下）、**独立下载通知**（可以离开 App、锁屏）、
 * **下载完点击安装**的标准体验。
 *
 * 这里只负责：查最新版本、挑 APK 资源、发起系统下载、轮询进度、调起安装。
 */
import { registerPlugin } from '@capacitor/core';

interface EchoAppPlugin {
  moveToBackground(): Promise<void>;
  downloadApk(options: {
    url: string;
    fileName: string;
    title: string;
    description: string;
  }): Promise<{ id: number }>;
  queryDownload(options: { id: number }): Promise<{
    status: 'pending' | 'running' | 'paused' | 'successful' | 'failed' | 'unknown';
    downloadedBytes?: number;
    totalBytes?: number;
    localPath?: string;
    reason?: number;
  }>;
  installApk(options: { path: string }): Promise<{ started: boolean }>;
}

const EchoApp = registerPlugin<EchoAppPlugin>('EchoApp');

import { formatReleaseNotes } from '@shared/appVersion';

/** 发布仓库（Release 里挂 APK 资产）。 */
export const RELEASE_REPO = 'xhaoh94/HppMusic';
const API_BASE = `https://api.github.com/repos/${RELEASE_REPO}/releases`;

export interface AppUpdateInfo {
  /** 规范化后的版本号（去掉 tag 的 v 前缀） */
  version: string;
  tag: string;
  notes: string;
  /** APK 下载地址（已应用代理） */
  apkUrl: string;
  /** 发布页，下载失败时给用户一个退路 */
  pageUrl: string;
  publishedAt: string;
  size: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** 代理前缀（可选）：形如 `https://ghproxy.net/`，拼在原始地址前面。 */
const withProxy = (url: string, proxyUrl?: string): string => {
  const proxy = (proxyUrl ?? '').trim().replace(/\/+$/, '');
  return proxy ? `${proxy}/${url}` : url;
};

/**
 * 从 release 资源里挑 APK。
 *
 * 发布里可能还有 `.zip`、校验文件等，只认 `.apk`；多个 APK 时取体积最大的那个
 * （debug 包与签名包并存时，正式包通常更大且是用户要的那个）。
 */
export const pickApkAsset = (assets: unknown): { url: string; size: number } | null => {
  if (!Array.isArray(assets)) return null;
  let best: { url: string; size: number } | null = null;
  for (const entry of assets) {
    const asset = asRecord(entry);
    if (!asset) continue;
    const name = String(asset.name ?? '').toLowerCase();
    const url = String(asset.browser_download_url ?? '');
    if (!name.endsWith('.apk') || !url) continue;
    const size = Number(asset.size ?? 0) || 0;
    if (!best || size > best.size) best = { url, size };
  }
  return best;
};

/** 把一个 GitHub release 映射成更新信息；不含 APK 或信息不全时返回 null。 */
export const mapRelease = (
  release: unknown,
  options: { proxyUrl?: string } = {},
): AppUpdateInfo | null => {
  const record = asRecord(release);
  if (!record) return null;
  const tag = String(record.tag_name ?? '').trim();
  if (!tag) return null;
  const apk = pickApkAsset(record.assets);
  if (!apk) return null;
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    notes: formatReleaseNotes(String(record.body ?? '')),
    apkUrl: withProxy(apk.url, options.proxyUrl),
    pageUrl: withProxy(String(record.html_url ?? ''), options.proxyUrl),
    publishedAt: String(record.published_at ?? ''),
    size: apk.size,
  };
};

/**
 * 拉取发布列表并挑出**最新的一个可用版本**（按发布时间排序，GitHub 返回本身即倒序）。
 *
 * 不在这里判断“比当前版本新”，交给调用方用 `isNewerVersion` 决定 —— 这样
 * 检查逻辑与版本比较规则各自独立、都能单独测。
 */
export const fetchLatestRelease = async (options: {
  includePrerelease?: boolean;
  proxyUrl?: string;
} = {}): Promise<AppUpdateInfo | null> => {
  const response = await fetch(withProxy(`${API_BASE}?per_page=10`, options.proxyUrl), {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`检查更新失败（HTTP ${response.status}）`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.draft === true) continue;
    if (record.prerelease === true && !options.includePrerelease) continue;
    const mapped = mapRelease(record, { proxyUrl: options.proxyUrl });
    if (mapped) return mapped;
  }
  return null;
};

/** 发起系统下载，返回下载任务 id。 */
export const startApkDownload = (info: AppUpdateInfo): Promise<number> =>
  EchoApp.downloadApk({
    url: info.apkUrl,
    fileName: `HppMusic-${info.version}.apk`,
    title: `HppMusic ${info.version}`,
    description: '正在下载更新，可在通知栏查看进度',
  }).then((result) => result.id);

export const queryApkDownload = (id: number) => EchoApp.queryDownload({ id });

/** 打开系统安装界面。需要系统“安装未知应用”权限，缺失时原生会跳去授权页。 */
export const installApk = (path: string): Promise<{ started: boolean }> =>
  EchoApp.installApk({ path });

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
};
