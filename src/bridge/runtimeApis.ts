/**
 * 桌面端其余 `window.electron.*` 命名空间在移动端的对应实现。
 *
 * 只补渲染层真正会读的那几个：
 * - `storage`：设置项持久化（sqlitePersist 插件）+ 播放队列/历史快照
 * - `log`：logger.ts 直读 `electron.log`
 * - `appInfo`：设置页要显示版本号
 * - `apiServer`：Loading 页要拿服务状态
 *
 * 其余（托盘 / 桌面歌词 / 迷你播放器 / 更新器 / 音频设备 / 插件市场…）安卓上没有对应物，
 * 一律不提供 —— 渲染层对这些位置普遍写了 `?.`，缺了会自然降级。**不要**给它们塞空实现，
 * 否则 `if (window.electron?.x?.y)` 这类能力判断会恒为真，反而把不存在的功能"打开"。
 */
import './polyfills';
import { DEFAULT_NETWORK_SETTINGS, normalizeNetworkSettings } from '@shared/network';

export { createStorageApi } from './storage';

// ── ipcRenderer / windowControl ──

/**
 * 桌面窗口相关的 IPC。渲染层有几处**不带 `?.`** 地直接调
 * （App.vue / TitleBar.vue / WindowControls.vue 的 `ipc.on`），所以必须存在。
 *
 * `invoke` 一律 resolve undefined：唯一会被读返回值的调用点
 * （setting.ts 的 `window-background:get`）自带 `if (!result) return`。
 */
export const createIpcRendererApi = () => ({
  on: () => () => {},
  once: () => () => {},
  off: () => {},
  removeListener: () => {},
  removeAllListeners: () => {},
  send: () => {},
  sendSync: () => undefined,
  invoke: async () => undefined,
});

/** 桌面端是 `windowControl(action)` 的**函数**形态，不是对象。 */
export const createWindowControlApi = () => () => {};

// ── log ──

const consoleFor =
  (level: 'info' | 'warn' | 'error' | 'debug') =>
  (...args: unknown[]) => {
    // verbose 归到 debug，避免刷屏
    console[level]('[renderer]', ...args);
  };

export const createLogApi = () => ({
  info: consoleFor('info'),
  warn: consoleFor('warn'),
  error: consoleFor('error'),
  debug: consoleFor('debug'),
  verbose: consoleFor('debug'),
});

// ── appInfo / apiServer ──

export const createAppInfoApi = (version: string) => ({
  get: async () => ({ version, isPrerelease: false, isPackaged: true }),
  getChangelog: async () => '',
  relaunch: async () => {
    window.location.reload();
    return true;
  },
  onOpenSettings: () => () => {},
});

const NETWORK_SETTINGS_KEY = 'echo.mobile.networkSettings';
const readLocalJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeLocalJson = (key: string, value: unknown) => {
  localStorage.setItem(key, JSON.stringify(value));
};

export const createNetworkApi = () => ({
  get: async () => ({
    settings: normalizeNetworkSettings(readLocalJson(NETWORK_SETTINGS_KEY, DEFAULT_NETWORK_SETTINGS)),
    hasProxyPassword: false,
  }),
  update: async (request: { settings?: Record<string, unknown> }) => {
    const settings = normalizeNetworkSettings({
      ...readLocalJson(NETWORK_SETTINGS_KEY, DEFAULT_NETWORK_SETTINGS),
      ...(request?.settings ?? {}),
    });
    writeLocalJson(NETWORK_SETTINGS_KEY, settings);
    return { settings, hasProxyPassword: false };
  },
});

export const createApiServerApi = () => ({
  start: async () => ({ success: true, state: 'ready', updatedAt: Date.now() }),
  status: async () => ({ state: 'ready', updatedAt: Date.now() }),
  identity: async () => {
    const mod = await import('./deviceIdentity');
    const device = mod.getDeviceIdentity();
    return { guid: device.guid, mac: device.mac, serverDev: 'EchoMusic', mid: device.mid };
  },
});
