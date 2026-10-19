/**
 * 更新流程的状态机。
 *
 * 关键点：
 * 1. **一次只查一次、一次只下一个**：连点“检查更新”不会发出多个请求，也不会
 *    起两个下载任务（系统的下载通知里出现两条同样的包，用户会以为是两条广告）。
 * 2. **进度靠轮询而不是事件**：DownloadManager 没有回调进 WebView 的通道，
 *    800ms 轮一次足够（系统下载器自己的通知栏是实时的）。
 * 3. **离开页面要停轮询**：composable 随组件卸载清理，避免后台一直转请求。
 */
import { computed, onScopeDispose, ref } from 'vue';
import { isNewerVersion, stripInternalBuild } from '@shared/appVersion';
import {
  fetchLatestRelease,
  installApk as installApkFile,
  queryApkDownload,
  startApkDownload,
  type AppUpdateInfo,
} from '@mobile/adapters/appUpdate';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'downloaded'
  | 'error';

const POLL_INTERVAL_MS = 800;

export const useAppUpdate = () => {
  const phase = ref<UpdatePhase>('idle');
  const info = ref<AppUpdateInfo | null>(null);
  const error = ref('');
  const downloadedBytes = ref(0);
  const totalBytes = ref(0);
  const localPath = ref('');

  let pollTimer: number | null = null;
  let downloadId: number | null = null;
  let disposed = false;
  /** 每次重新检查/下载都递增，旧轮询回来时直接丢弃 */
  let generation = 0;

  const clearPoll = () => {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const percent = computed(() => {
    if (!totalBytes.value) return 0;
    return Math.min(100, Math.max(0, Math.round((downloadedBytes.value / totalBytes.value) * 100)));
  });

  const poll = async () => {
    if (disposed || downloadId === null) return;
    const currentGeneration = generation;
    try {
      const status = await queryApkDownload(downloadId);
      if (disposed || currentGeneration !== generation) return;
      downloadedBytes.value = Math.max(0, Number(status.downloadedBytes ?? 0));
      totalBytes.value = Math.max(0, Number(status.totalBytes ?? 0));
      if (status.status === 'successful') {
        localPath.value = status.localPath ?? '';
        phase.value = 'downloaded';
        clearPoll();
        return;
      }
      if (status.status === 'failed') {
        phase.value = 'error';
        error.value = '下载失败，请重试（已下载部分不会浪费，可再次点按继续）';
        clearPoll();
        return;
      }
      // pending/paused（网络中断时系统会自己续传）都继续轮询
      phase.value = status.status === 'paused' ? 'paused' : 'downloading';
      pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    } catch (cause) {
      if (disposed || currentGeneration !== generation) return;
      phase.value = 'error';
      error.value = cause instanceof Error ? cause.message : '查询下载进度失败';
      clearPoll();
    }
  };

  /** 检查更新。currentVersion 由调用方传入（应用内版本带 -mobile.N 后缀）。 */
  const check = async (options: {
    currentVersion: string;
    includePrerelease?: boolean;
    proxyUrl?: string;
  }): Promise<AppUpdateInfo | null> => {
    if (phase.value === 'checking') return info.value;
    generation += 1;
    clearPoll();
    phase.value = 'checking';
    error.value = '';
    try {
      const latest = await fetchLatestRelease({
        includePrerelease: options.includePrerelease,
        proxyUrl: options.proxyUrl,
      });
      if (disposed) return null;
      info.value = latest;
      // 当前版本带 `-mobile.N` 构建后缀，去掉后再比，否则同一发布会被当成新版本。
      const currentBase = stripInternalBuild(options.currentVersion);
      if (!latest || !isNewerVersion(latest.version, currentBase)) {
        phase.value = 'latest';
        return null;
      }
      phase.value = 'available';
      return latest;
    } catch (cause) {
      if (disposed) return null;
      phase.value = 'error';
      error.value = cause instanceof Error ? cause.message : '检查更新失败';
      return null;
    }
  };

  /** 开始下载（或继续上一次失败的下载）。 */
  const download = async (): Promise<boolean> => {
    if (phase.value === 'downloading' || phase.value === 'paused') return true;
    const target = info.value;
    if (!target) return false;
    generation += 1;
    clearPoll();
    downloadedBytes.value = 0;
    totalBytes.value = target.size;
    localPath.value = '';
    phase.value = 'downloading';
    error.value = '';
    try {
      downloadId = await startApkDownload(target);
      if (disposed) return false;
      void poll();
      return true;
    } catch (cause) {
      if (disposed) return false;
      phase.value = 'error';
      error.value = cause instanceof Error ? cause.message : '发起下载失败';
      return false;
    }
  };

  /** 调起系统安装。成功返回 true；缺权限时原生会跳到授权页并报错。 */
  const install = async (): Promise<boolean> => {
    if (phase.value !== 'downloaded' || !localPath.value) return false;
    try {
      const result = await installApkFile(localPath.value);
      return result.started;
    } catch (cause) {
      phase.value = 'error';
      error.value =
        cause instanceof Error ? cause.message : '打开安装界面失败，请到通知栏点击安装包';
      return false;
    }
  };

  const reset = () => {
    generation += 1;
    clearPoll();
    downloadId = null;
    phase.value = 'idle';
    error.value = '';
    downloadedBytes.value = 0;
    totalBytes.value = 0;
    localPath.value = '';
  };

  onScopeDispose(() => {
    disposed = true;
    generation += 1;
    clearPoll();
  });

  return {
    phase,
    info,
    error,
    downloadedBytes,
    totalBytes,
    localPath,
    percent,
    check,
    download,
    install,
    reset,
  };
};
