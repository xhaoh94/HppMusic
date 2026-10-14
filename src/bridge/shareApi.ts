import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { extractShareTarget, type ShareTarget } from '@shared/share';

interface NativeSharePlugin {
  copy(options: { text: string }): Promise<{ ok: boolean }>;
  readClipboard(): Promise<{ text: string }>;
  share(options: { text: string }): Promise<{ ok: boolean }>;
  getPendingShare(): Promise<{ text: string }>;
  addListener(event: 'shareOpen', callback: (event: { text: string }) => void): Promise<PluginListenerHandle>;
}

const NativeShare = registerPlugin<NativeSharePlugin>('EchoShare');

/**
 * 主动唤起系统分享面板。
 *
 * 单独导出，而不是让 UI 直接写 `window.electron.share.share(...)`：vendor 的
 * `electron.d.ts` 里 `share` 的类型还停在「复制 / 读剪贴板 / 接收分享」三项，
 * 没跟上实现里已经有的 send（`EchoSharePlugin.share`）。断言收在本文件里，
 * UI 层就不用带 any。失败（含用户取消）一律返回 false，由调用方决定是否兜底。
 */
export const sendShareText = async (text: string): Promise<boolean> => {
  try {
    const { ok } = await NativeShare.share({ text });
    return Boolean(ok);
  } catch {
    return false;
  }
};

/** 复制文本到系统剪贴板（分享不可用时的兜底路径） */
export const copyShareText = async (text: string): Promise<boolean> => {
  try {
    const { ok } = await NativeShare.copy({ text });
    return Boolean(ok);
  } catch {
    return false;
  }
};

export const createNativeShareApi = () => ({
  copy: async (text: string) => (await NativeShare.copy({ text })).ok,
  readClipboard: async () => (await NativeShare.readClipboard()).text,
  share: async (text: string) => (await NativeShare.share({ text })).ok,
  captureRectToClipboard: async () => false,
  onOpen: (handler: (target: ShareTarget) => void) => {
    let active = true;
    let handle: PluginListenerHandle | undefined;
    const dispatch = ({ text }: { text: string }) => {
      if (!active) return;
      const target = extractShareTarget(text);
      if (target) handler(target);
    };
    void NativeShare.addListener('shareOpen', dispatch).then(async (listener) => {
      if (!active) {
        await listener.remove();
        return;
      }
      handle = listener;
      dispatch(await NativeShare.getPendingShare());
    });
    return () => {
      active = false;
      if (handle) void handle.remove();
    };
  },
});
