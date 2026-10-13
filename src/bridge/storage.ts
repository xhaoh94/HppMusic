import type {
  StorageAppendQueueItemsPayload,
  StorageHistoryEntry,
  StorageHistoryGetEntriesPayload,
  StorageHistoryRecordPlayPayload,
  StorageHistoryRemoveEntriesPayload,
  StoragePlaybackQueueState,
  StoragePlaybackSnapshot,
  StorageQueueIdPayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageReplaceQueuePayload,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '@shared/storage';

type JsonRecord = Record<string, unknown>;
type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

type PlaybackSnapshot = StoragePlaybackSnapshot;

type HistoryState = {
  entries: StorageHistoryEntry[];
};

const KV_PREFIX = 'echo.mobile.kv.';
const QUEUE_SNAPSHOT_KEY = 'echo.mobile.playbackSnapshot';
const HISTORY_KEY = 'echo.mobile.history';
const DEFAULT_HISTORY_LIMIT = 500;

const storage = (): LocalStorageLike => {
  const value = (globalThis as typeof globalThis & { localStorage?: LocalStorageLike })
    .localStorage;
  if (!value) throw new Error('localStorage is unavailable');
  return value;
};

const jsonText = (value: unknown, label: string): string => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(`Failed to serialize ${label}`, { cause: error });
  }
  if (text === undefined) throw new Error(`Failed to serialize ${label}`);
  return text;
};

const readJson = <T>(key: string, fallback: T): T => {
  const raw = storage().getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse persisted value: ${key}`, { cause: error });
  }
};

const writeJson = (key: string, value: unknown): void => {
  const text = jsonText(value, key);
  const target = storage();
  target.setItem(key, text);
  if (target.getItem(key) !== text) throw new Error(`Failed to persist value: ${key}`);
};

const removeKey = (key: string): void => {
  const target = storage();
  target.removeItem(key);
  if (target.getItem(key) !== null) throw new Error(`Failed to remove persisted value: ${key}`);
};

const emptySnapshot = (): PlaybackSnapshot => ({
  queues: [],
  activeQueueId: '',
  lastNonFmQueueId: '',
});

const queueIdOf = (queue: unknown): string =>
  String((queue as { id?: unknown } | null)?.id ?? '').trim();

const requireQueue = (queue: unknown): JsonRecord & { id: string } => {
  if (!queue || typeof queue !== 'object' || !queueIdOf(queue)) {
    throw new Error('A queue with a non-empty id is required');
  }
  return { ...(queue as JsonRecord), id: queueIdOf(queue) };
};

const queueSongs = (queue: JsonRecord): unknown[] =>
  Array.isArray(queue.songs) ? queue.songs.slice() : [];

const normalizeQueue = (queue: JsonRecord): StoragePlaybackQueueState => {
  const next = { ...queue, id: queueIdOf(queue) } as unknown as StoragePlaybackQueueState;
  next.songs = queueSongs(queue) as StoragePlaybackQueueState['songs'];
  next.queuedNextTrackIds = Array.isArray(queue.queuedNextTrackIds)
    ? queue.queuedNextTrackIds.map((id) => String(id))
    : [];
  next.currentTrackId =
    queue.currentTrackId === undefined || queue.currentTrackId === null
      ? null
      : String(queue.currentTrackId);
  if (!Number.isFinite(Number(next.songCount))) next.songCount = next.songs.length;
  if (!Number.isFinite(Number(next.filteredInvalidCount))) next.filteredInvalidCount = 0;
  if (!next.meta || typeof next.meta !== 'object') next.meta = {};
  return next;
};

const readSnapshot = (): PlaybackSnapshot => {
  const value = readJson<Partial<PlaybackSnapshot> | null>(QUEUE_SNAPSHOT_KEY, null);
  if (value === null) return emptySnapshot();
  if (!Array.isArray(value.queues)) throw new Error('Invalid persisted playback snapshot');
  return {
    queues: value.queues.map((queue) => normalizeQueue(requireQueue(queue))),
    activeQueueId: String(value.activeQueueId ?? ''),
    lastNonFmQueueId: String(value.lastNonFmQueueId ?? ''),
  };
};

const writeSnapshot = (snapshot: PlaybackSnapshot): void => {
  writeJson(QUEUE_SNAPSHOT_KEY, snapshot);
};

const updatePointers = (
  snapshot: PlaybackSnapshot,
  payload: { activeQueueId?: unknown; lastNonFmQueueId?: unknown },
): void => {
  if (typeof payload.activeQueueId === 'string') snapshot.activeQueueId = payload.activeQueueId;
  if (typeof payload.lastNonFmQueueId === 'string') {
    snapshot.lastNonFmQueueId = payload.lastNonFmQueueId;
  }
};

const findQueue = (
  snapshot: PlaybackSnapshot,
  queueId: unknown,
): StoragePlaybackQueueState | null => {
  const id = String(queueId ?? '').trim();
  return id ? (snapshot.queues.find((queue) => queue.id === id) ?? null) : null;
};

const replaceQueueMeta = (
  target: StoragePlaybackQueueState,
  source: JsonRecord,
): StoragePlaybackQueueState => {
  const songs = target.songs;
  const next = normalizeQueue({ ...target, ...source, id: target.id, songs });
  next.songs = songs;
  return next;
};

const historySongKeyOf = (song: StorageHistoryRecordPlayPayload['song']): string => {
  const mixSongId = String(song.mixSongId ?? '').trim();
  if (mixSongId && mixSongId !== '0') return `mx:${mixSongId}`;
  const hash = String(song.hash ?? '')
    .trim()
    .toLowerCase();
  if (hash) return `hash:${hash}`;
  const fileId = String(song.fileId ?? '').trim();
  if (fileId) return `file:${fileId}`;
  return `id:${String(song.id ?? '')}`;
};

const historyIdOf = (song: StorageHistoryRecordPlayPayload['song']): string =>
  String(song.mixSongId || song.fileId || song.id || '0');

const historyKeyOf = (song: StorageHistoryRecordPlayPayload['song'], playedAt: number): string =>
  `${historyIdOf(song)}:${playedAt}`;

const readHistory = (): HistoryState => {
  const value = readJson<HistoryState | StorageHistoryEntry[] | null>(HISTORY_KEY, null);
  if (value === null) return { entries: [] };
  const entries = Array.isArray(value) ? value : value?.entries;
  if (!Array.isArray(entries)) throw new Error('Invalid persisted history');
  return { entries: entries.slice() };
};

const historyLimit = (value: unknown): number => {
  if (value === undefined || value === null) return DEFAULT_HISTORY_LIMIT;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid history maxEntries');
  return Math.max(0, Math.floor(number));
};

const sortHistory = (entries: StorageHistoryEntry[]): StorageHistoryEntry[] =>
  entries.slice().sort((left, right) => right.lastPlayedAt - left.lastPlayedAt);

const writeHistory = (entries: StorageHistoryEntry[]): void => {
  writeJson(HISTORY_KEY, { entries: sortHistory(entries) });
};

const ok = (): { ok: true } => ({ ok: true });

export const createStorageApi = () => ({
  getKv: async <T = unknown>(key: string): Promise<T | null> =>
    readJson<T | null>(KV_PREFIX + key, null),

  setKv: async (key: string, value: unknown): Promise<{ ok: true }> => {
    writeJson(KV_PREFIX + key, value);
    return ok();
  },

  deleteKv: async (key: string): Promise<{ ok: true }> => {
    removeKey(KV_PREFIX + key);
    return ok();
  },

  resetAll: async (): Promise<{ ok: true }> => {
    const target = storage();
    const doomed: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key && (key.startsWith(KV_PREFIX) || key === QUEUE_SNAPSHOT_KEY || key === HISTORY_KEY)) {
        doomed.push(key);
      }
    }
    doomed.forEach(removeKey);
    return ok();
  },

  getPlaybackSnapshot: async (): Promise<PlaybackSnapshot> => readSnapshot(),

  getPlaybackQueue: async (
    payload: StorageQueueIdPayload,
  ): Promise<StoragePlaybackQueueState | null> => findQueue(readSnapshot(), payload?.queueId),

  replacePlaybackQueue: async (payload: StorageReplaceQueuePayload): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const queue = normalizeQueue(requireQueue(payload?.queue));
    const index = snapshot.queues.findIndex((item) => item.id === queue.id);
    if (index === -1) snapshot.queues.push(queue);
    else snapshot.queues[index] = queue;
    updatePointers(snapshot, payload);
    writeSnapshot(snapshot);
    return ok();
  },

  appendPlaybackQueueItems: async (
    payload: StorageAppendQueueItemsPayload,
  ): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const queuePayload = requireQueue(payload?.queue);
    const id = queuePayload.id;
    let target = findQueue(snapshot, id);
    const incoming = Array.isArray(payload?.songs) ? payload.songs.slice() : [];
    if (!target) {
      target = normalizeQueue({
        ...queuePayload,
        songs: [...queueSongs(queuePayload), ...incoming],
      });
      snapshot.queues.push(target);
    } else {
      const index = snapshot.queues.indexOf(target);
      target = replaceQueueMeta(target, queuePayload);
      target.songs = [...target.songs, ...incoming] as StoragePlaybackQueueState['songs'];
      if (queuePayload.songCount === undefined) target.songCount = target.songs.length;
      snapshot.queues[index] = target;
    }
    updatePointers(snapshot, payload);
    writeSnapshot(snapshot);
    return ok();
  },

  removePlaybackQueueItem: async (
    payload: StorageRemoveQueueItemPayload,
  ): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const target = findQueue(snapshot, payload?.queueId);
    if (target) {
      const songId = String(payload.songId);
      target.songs = target.songs.filter((song) => String(song.id) !== songId);
      target.songCount = target.songs.length;
      if (payload.queuedNextTrackIds !== undefined) {
        target.queuedNextTrackIds = payload.queuedNextTrackIds.map((id) => String(id));
      }
      if (payload.currentTrackId !== undefined) {
        target.currentTrackId =
          payload.currentTrackId === null ? null : String(payload.currentTrackId);
      }
      if (payload.updatedAt !== undefined) target.updatedAt = payload.updatedAt;
      writeSnapshot(snapshot);
    }
    return ok();
  },

  reorderPlaybackQueueItems: async (
    payload: StorageReorderQueueItemsPayload,
  ): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const target = findQueue(snapshot, payload?.queueId);
    if (target) {
      if (!Array.isArray(payload.songs)) throw new Error('Queue songs must be an array');
      target.songs = payload.songs.slice();
      target.songCount = target.songs.length;
      if (payload.updatedAt !== undefined) target.updatedAt = payload.updatedAt;
      writeSnapshot(snapshot);
    }
    return ok();
  },

  removePlaybackQueue: async (payload: StorageQueueIdPayload): Promise<PlaybackSnapshot> => {
    const snapshot = readSnapshot();
    const id = String(payload?.queueId ?? '').trim();
    if (!id) throw new Error('A queueId is required');
    snapshot.queues = snapshot.queues.filter((queue) => queue.id !== id);
    if (snapshot.activeQueueId === id) snapshot.activeQueueId = snapshot.queues[0]?.id ?? '';
    if (snapshot.lastNonFmQueueId === id) snapshot.lastNonFmQueueId = snapshot.queues[0]?.id ?? '';
    writeSnapshot(snapshot);
    return snapshot;
  },

  clearPlaybackQueue: async (payload: StorageUpdateQueueMetaPayload): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const queuePayload = requireQueue(payload?.queue);
    const existing = findQueue(snapshot, queuePayload.id);
    const next = normalizeQueue({ ...queuePayload, songs: [] });
    next.songCount = 0;
    if (existing) snapshot.queues[snapshot.queues.indexOf(existing)] = next;
    else snapshot.queues.push(next);
    updatePointers(snapshot, payload);
    writeSnapshot(snapshot);
    return ok();
  },

  setQueueCurrentTrack: async (
    payload: StorageSetQueueCurrentTrackPayload,
  ): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const target = findQueue(snapshot, payload?.queueId);
    if (target) {
      target.currentTrackId =
        payload.trackId === undefined || payload.trackId === null ? null : String(payload.trackId);
      target.updatedAt = Date.now();
      writeSnapshot(snapshot);
    }
    return ok();
  },

  updatePlaybackQueueMeta: async (
    payload: StorageUpdateQueueMetaPayload,
  ): Promise<{ ok: true }> => {
    const snapshot = readSnapshot();
    const queuePayload = requireQueue(payload?.queue);
    const existing = findQueue(snapshot, queuePayload.id);
    if (existing)
      snapshot.queues[snapshot.queues.indexOf(existing)] = replaceQueueMeta(existing, queuePayload);
    else snapshot.queues.push(normalizeQueue(queuePayload));
    updatePointers(snapshot, payload);
    writeSnapshot(snapshot);
    return ok();
  },

  setActiveQueue: async (queueId: string): Promise<{ ok: true }> => {
    const id = String(queueId ?? '').trim();
    if (!id) throw new Error('A queueId is required');
    const snapshot = readSnapshot();
    snapshot.activeQueueId = id;
    snapshot.lastNonFmQueueId = id;
    writeSnapshot(snapshot);
    return ok();
  },

  getHistoryEntries: async (
    payload: StorageHistoryGetEntriesPayload = {},
  ): Promise<StorageHistoryEntry[]> => {
    const entries = sortHistory(readHistory().entries);
    const offset =
      payload.offset === undefined ? 0 : Math.max(0, Math.floor(Number(payload.offset)));
    const limit =
      payload.limit === undefined ? entries.length : Math.max(0, Math.floor(Number(payload.limit)));
    if (!Number.isFinite(offset) || !Number.isFinite(limit))
      throw new Error('Invalid history range');
    return entries.slice(offset, offset + limit);
  },

  recordHistoryPlay: async (
    payload: StorageHistoryRecordPlayPayload,
  ): Promise<StorageHistoryEntry | null> => {
    if (!payload?.song) throw new Error('A song is required');
    const playedAt = payload.playedAt === undefined ? Date.now() : Number(payload.playedAt);
    if (!Number.isFinite(playedAt)) throw new Error('Invalid playedAt');
    const state = readHistory();
    const identity = historySongKeyOf(payload.song);
    const existingIndex = state.entries.findIndex(
      (entry) => historySongKeyOf(entry.song) === identity,
    );
    const entry: StorageHistoryEntry = {
      song: payload.song,
      lastPlayedAt: playedAt,
      playCount:
        Math.max(0, Number(existingIndex < 0 ? 0 : state.entries[existingIndex].playCount) || 0) +
        1,
      historyKey: historyKeyOf(payload.song, playedAt),
    };
    if (existingIndex >= 0) state.entries.splice(existingIndex, 1);
    state.entries.unshift(entry);
    const limited = sortHistory(state.entries).slice(0, historyLimit(payload.maxEntries));
    writeHistory(limited);
    return limited.some((item) => item.historyKey === entry.historyKey) ? entry : null;
  },

  removeHistoryEntries: async (
    payload: StorageHistoryRemoveEntriesPayload,
  ): Promise<{ ok: true }> => {
    if (!Array.isArray(payload?.historyKeys)) throw new Error('historyKeys must be an array');
    const keys = new Set(payload.historyKeys.map(String));
    const entries = readHistory().entries.filter((entry) => !keys.has(entry.historyKey));
    writeHistory(entries);
    return ok();
  },

  clearHistory: async (): Promise<{ ok: true }> => {
    removeKey(HISTORY_KEY);
    return ok();
  },
});

export { HISTORY_KEY, QUEUE_SNAPSHOT_KEY };
