import { appleProvider } from '../main/external/providers/apple';
import { kugouProvider } from '../main/external/providers/kugou';
import { kuwoProvider } from '../main/external/providers/kuwo';
import { neteaseProvider } from '../main/external/providers/netease';
import { qishuiProvider } from '../main/external/providers/qishui';
import { qqmusicProvider } from '../main/external/providers/qqmusic';
import { spotifyProvider } from '../main/external/providers/spotify';
import { textProvider } from '../main/external/providers/text';
import type { ExternalProvider, ProviderContext } from '../main/external/types';
import type { ExternalProviderId, ResolvePlaylistRequest, ResolvePlaylistResponse } from '@shared/external';

const providers: ExternalProvider[] = [
  neteaseProvider,
  qqmusicProvider,
  kuwoProvider,
  kugouProvider,
  qishuiProvider,
  spotifyProvider,
  appleProvider,
  textProvider,
];

const byId = new Map<ExternalProviderId, ExternalProvider>(providers.map((provider) => [provider.id, provider]));

const responseData = async (response: Response) => {
  if (!response.ok) throw new Error(`远端返回 ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const context: ProviderContext = {
  fetchJson: async (url, headers) => responseData(await fetch(url, { headers })),
  fetchText: async (url, headers) => String(await responseData(await fetch(url, { headers }))),
  postForm: async (url, form, headers) => {
    const body = new URLSearchParams();
    Object.entries(form).forEach(([key, value]) => body.set(key, value));
    return responseData(await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(headers ?? {}) },
      body,
    }));
  },
};

export const createExternalApi = () => ({
  resolvePlaylist: async (request: ResolvePlaylistRequest): Promise<ResolvePlaylistResponse> => {
    const input = String(request?.input ?? '').trim();
    if (!input) return { ok: false, error: '请输入歌单链接或文本', code: 'EMPTY_INPUT' };
    const provider = request.provider && request.provider !== 'auto'
      ? byId.get(request.provider)
      : providers.find((item) => item.canHandle(input));
    if (!provider) return { ok: false, error: '无法识别输入来源，请检查链接是否正确', code: 'UNDETECTABLE' };
    try {
      const playlist = await provider.resolve({ ...request, input, provider: provider.id }, context);
      return { ok: true, playlist };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '解析歌单失败', code: 'RESOLVE_FAILED' };
    }
  },
});
