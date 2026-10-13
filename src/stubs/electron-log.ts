/**
 * `electron-log` 的桩实现。
 *
 * 上游 `src/main/external/providers/*`（外部歌单导入的 8 个平台解析器）用它打日志。
 * 那些 provider 本身是**浏览器安全**的（只用 fetch / axios + 正则解析），
 * 唯一的主进程依赖就是这个 logger —— 所以这里把日志转给 console 就够了，
 * 不需要为了它们引入整个 Electron 日志栈。
 *
 * 保持上游文件逐字节不变（靠 vite alias + tsconfig paths 重定向），
 * 这样 `scripts/sync-upstream.mjs` 可以全量覆盖 src/main/external。
 */
type LogFn = (...args: unknown[]) => void;

const bind =
  (method: 'debug' | 'info' | 'warn' | 'error'): LogFn =>
  (...args) => {
    // 用 console 而非静默：排查真机问题时 logcat 里能直接看到
    console[method === 'debug' ? 'debug' : method]('[external]', ...args);
  };

const log = {
  debug: bind('debug'),
  info: bind('info'),
  warn: bind('warn'),
  error: bind('error'),
  verbose: bind('debug'),
  silly: bind('debug'),
  log: bind('info'),
  /** 上游若调用 scope()，返回同一个无状态 logger 即可 */
  scope: () => log,
  transports: {
    file: { level: 'info' as const },
    console: { level: 'info' as const },
  },
};

export default log;
