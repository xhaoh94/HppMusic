import './polyfills';
import {
  cacheNativeAudioResource,
  deleteNativeAudioResource,
  nativeAudioResourceExists,
} from './nativePlayer';

const DB_NAME = 'echo.mobile.audio-effects';
const STORE_NAME = 'files';
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;

type StoredResource = {
  id: string;
  kind: 'ir' | 'vpf';
  name: string;
  data: ArrayBuffer;
  size: number;
  importedAt: number;
};

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前 WebView 不支持音效本地存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('音效存储初始化失败'));
  });

const putResource = async (resource: StoredResource) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(resource);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('音效保存失败'));
  });
  db.close();
};

const hasResource = async (id: string) => {
  const db = await openDb();
  const exists = await new Promise<boolean>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getKey(id);
    request.onsuccess = () => resolve(request.result !== undefined);
    request.onerror = () => reject(request.error ?? new Error('音效检查失败'));
  });
  db.close();
  return exists;
};

const deleteResource = async (id: string) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('音效删除失败'));
  });
  db.close();
};

const fetchCandidate = async (urls: string[], label: string): Promise<ArrayBuffer> => {
  let lastError = '';
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_RESOURCE_BYTES) throw new Error('音效文件超过 64MB 限制');
      const data = await response.arrayBuffer();
      if (!data.byteLength || data.byteLength > MAX_RESOURCE_BYTES) throw new Error('音效文件为空或过大');
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${label}下载失败${lastError ? `：${lastError}` : ''}`);
};

const pathFor = (id: string, name: string) => `mobile-audio-effect://${id}/${name}`;

const pickAudioFiles = (): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.wav,.wave,.irs,audio/wav,audio/x-wav';
    input.onchange = () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    input.oncancel = () => {
      resolve([]);
      input.remove();
    };
    input.click();
  });

const displayName = (name: string) => name.replace(/\.(?:wav|wave|irs)$/i, '').trim() || '未命名音效';
const idFromPath = (value: string) => value.match(/^mobile-audio-effect:\/\/([^/]+)/)?.[1] ?? '';
const isNativePath = (value: string) => value.startsWith('/data/') || value.includes('/files/audio-effects/');

/** 移动端先实现音效资源下载与持久化；DSP 播放器接入完成前不宣称可使用。 */
export const createAudioEffectsApi = () => ({
  importImpulseResponse: async () => {
    const selected = await pickAudioFiles();
    if (selected.length === 0) return { canceled: true, files: [] };
    const files = [];
    const errors: string[] = [];
    for (const file of selected) {
      try {
        const data = await file.arrayBuffer();
        if (!data.byteLength || data.byteLength > MAX_RESOURCE_BYTES) {
          throw new Error('文件为空或超过 64MB 限制');
        }
        const id = `imported-ir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await putResource({
          id: `${id}:ir`,
          kind: 'ir',
          name: displayName(file.name),
          data,
          size: data.byteLength,
          importedAt: Date.now(),
        });
        const path = await cacheNativeAudioResource(`${id}.wav`, data);
        files.push({
          id,
          name: displayName(file.name),
          size: data.byteLength,
          importedAt: Date.now(),
          format: 'wav',
          kind: 'imported-ir' as const,
          impulseResponsePath: path,
        });
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : '导入失败'}`);
      }
    }
    return {
      canceled: false,
      files,
      error: files.length === 0 ? errors[0] || '音效导入失败' : undefined,
      errors: errors.length ? errors : undefined,
    };
  },
  downloadCommunityAudioEffect: async (payload: {
    modelId: string | number;
    name: string;
    impulseResponseUrls: string[];
    vpfUrls: string[];
  }) => {
    const id = `community-effect-${String(payload.modelId)}`;
    try {
      const hasIr = payload.impulseResponseUrls.length > 0;
      const hasVpf = payload.vpfUrls.length > 0;
      if (!hasIr && !hasVpf) return { error: '音效没有可下载的资源地址' };
      let nativeIrPath = '';
      let nativeVpfPath = '';
      let totalSize = 0;
      if (hasIr) {
        const data = await fetchCandidate(payload.impulseResponseUrls, '卷积资源');
        await putResource({
          id: `${id}:ir`,
          kind: 'ir',
          name: payload.name,
          data,
          size: data.byteLength,
          importedAt: Date.now(),
        });
        totalSize += data.byteLength;
        nativeIrPath = await cacheNativeAudioResource(`${id}-impulse-response.wav`, data);
      }
      if (hasVpf) {
        const data = await fetchCandidate(payload.vpfUrls, 'VPF 资源');
        await putResource({
          id: `${id}:vpf`,
          kind: 'vpf',
          name: payload.name,
          data,
          size: data.byteLength,
          importedAt: Date.now(),
        });
        totalSize += data.byteLength;
        nativeVpfPath = await cacheNativeAudioResource(`${id}-effect.vpf`, data);
      }
      return {
        file: {
          id,
          name: payload.name,
          size: totalSize,
          importedAt: Date.now(),
          format: hasVpf && !hasIr ? 'vpf' : 'wav',
          kind: hasIr && hasVpf ? 'community-combined' : hasVpf ? 'community-vpf' : 'community-ir',
          impulseResponsePath: hasIr ? nativeIrPath || pathFor(id, 'impulse-response.wav') : undefined,
          vpfPath: hasVpf ? nativeVpfPath || pathFor(id, 'effect.vpf') : undefined,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : '音效下载失败' };
    }
  },
  deleteAudioEffect: async (filePath: string) => {
    if (isNativePath(filePath)) return deleteNativeAudioResource(filePath);
    const id = idFromPath(filePath);
    if (!id) return false;
    await Promise.allSettled([deleteResource(`${id}:ir`), deleteResource(`${id}:vpf`)]);
    return true;
  },
  reconcileAudioEffects: async <T extends { impulseResponsePath?: string; vpfPath?: string }>(files: T[]) => {
    const result: T[] = [];
    for (const file of files) {
      const paths = [file.impulseResponsePath, file.vpfPath].filter(Boolean) as string[];
      const valid = paths.length > 0 && (await Promise.all(paths.map((path) =>
        isNativePath(path) ? nativeAudioResourceExists(path) : hasResource(idFromPath(path)),
      ))).every(Boolean);
      if (valid) result.push(file);
    }
    return result;
  },
});
