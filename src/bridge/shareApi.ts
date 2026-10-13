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
