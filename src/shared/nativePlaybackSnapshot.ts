/** Android 原生已播放状态。恢复界面时只接收此快照，不重新发播放命令。 */
export interface NativePlaybackSnapshot {
  playing: boolean;
  paused: boolean;
  ended?: boolean;
  playWhenReady?: boolean;
  duration: number;
  timePos: number;
  trackSeq?: number;
  generation?: number;
  sampledAt?: number;
  mediaId?: string;
  trackId?: string;
  path?: string;
  backgroundQueueActive?: boolean;
}

export const nativeSnapshotTrackId = (snapshot: NativePlaybackSnapshot): string => {
  if (snapshot.trackId) return snapshot.trackId;
  const prefix = 'hppmusic-background-next:';
  return snapshot.mediaId?.startsWith(prefix) ? snapshot.mediaId.slice(prefix.length) : '';
};

/** visibilitychange / focus / pageshow 可在同一次恢复同时触发，只做一次读取。 */
export const createNativePlaybackReconciler = (options: {
  read: () => Promise<NativePlaybackSnapshot | null | undefined>;
  captureRevision: () => string;
  apply: (snapshot: NativePlaybackSnapshot) => void;
  afterApply?: () => Promise<void>;
}) => {
  let pending: Promise<void> | null = null;
  return (): Promise<void> => {
    if (pending) return pending;
    const revision = options.captureRevision();
    pending = (async () => {
      const snapshot = await options.read();
      // 读取期间用户可能点歌、停止或 seek；旧快照不能覆盖新意图。
      if (snapshot && revision === options.captureRevision()) {
        options.apply(snapshot);
        // 只有尚未执行的真实用户命令才可在采用当前落点后执行。
        await options.afterApply?.();
      }
    })().finally(() => { pending = null; });
    return pending;
  };
};
