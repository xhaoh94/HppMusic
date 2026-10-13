import './polyfills';

const FORMAT = 'echomusic-settings-backup';
const VERSION = 1;
const SETTING_KV_KEY = 'echo.mobile.kv.pinia:setting';

type BackupSummary = {
  createdAt: string;
  appVersion: string;
  includes: { settings: boolean; plugins: boolean };
  settingCount: number;
  pluginCount: number;
  pluginNames: string[];
};

type BackupPayload = {
  format: typeof FORMAT;
  version: number;
  summary: BackupSummary;
  settingsData?: Record<string, unknown>;
};

const encode = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
};

const decode = (value: string): BackupPayload => {
  const binary = atob(value.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as BackupPayload;
  if (parsed.format !== FORMAT || parsed.version !== VERSION) throw new Error('备份格式不兼容');
  return parsed;
};

const summaryOf = (settings: boolean, plugins: boolean, settingsData?: Record<string, unknown>) => ({
  createdAt: new Date().toISOString(),
  appVersion: 'mobile',
  includes: { settings, plugins: false },
  settingCount: settingsData ? Object.keys(settingsData).length : 0,
  pluginCount: 0,
  pluginNames: [],
});

const pickBackupText = (): Promise<string | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.echomusic-backup,.json,application/json,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
      input.remove();
    };
    input.oncancel = () => {
      resolve(null);
      input.remove();
    };
    input.click();
  });

export const createSettingsBackupApi = () => ({
  export: async (request: { settings: boolean; plugins: boolean; settingsData?: Record<string, unknown> }) => {
    const summary = summaryOf(request.settings, request.plugins, request.settingsData);
    const token = encode({
      format: FORMAT,
      version: VERSION,
      summary,
      ...(request.settings && request.settingsData ? { settingsData: request.settingsData } : {}),
    });
    const blob = new Blob([token], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `EchoMusic-${new Date().toISOString().slice(0, 10)}.echomusic-backup`;
    anchor.click();
    URL.revokeObjectURL(url);
    return { ok: true as const, canceled: false as const, filePath: 'mobile-download', summary };
  },
  inspect: async () => {
    const text = await pickBackupText();
    if (!text) return { ok: false as const, canceled: true as const };
    try {
      const payload = decode(text);
      return { ok: true as const, canceled: false as const, token: text.trim(), summary: payload.summary };
    } catch (error) {
      return { ok: false as const, canceled: false as const, error: error instanceof Error ? error.message : '备份文件无效' };
    }
  },
  import: async (request: { token: string; settings: boolean; plugins: boolean }) => {
    try {
      const payload = decode(request.token);
      if (request.settings && payload.settingsData) {
        localStorage.setItem(SETTING_KV_KEY, JSON.stringify(payload.settingsData));
      }
      return {
        ok: true as const,
        settingsImported: Boolean(request.settings && payload.settingsData),
        pluginsImported: 0,
        summary: payload.summary,
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '恢复备份失败' };
    }
  },
});
