/**
 * `@/plugins/taskPanel` 的桩实现。
 *
 * 上游用它做「后台任务面板」（云盘上传、外部歌单导入等长任务的状态聚合）。
 * 本项目 P0 不做这些功能，对应的两个 store（`cloudUpload` / `importTask`）
 * 也已被 `upstream.json` 的 exclude 排除，所以这里没有任何调用方。
 *
 * 与 `plugins-runtime.ts` 同样的策略：形状对得上，被调用就抛错。
 * 等 P4 做云盘/导入时，实现这里（或 vendoring 上游文件），而不是绕开任务面板。
 */

const notImplemented = (api: string): never => {
  throw new Error(
    `[stubs] 任务面板未实现（${api}）。请实现 src/stubs/plugins-task-panel.ts 后再启用相关功能。`,
  );
};

/** 内置任务的所有者 id（上游用它区分宿主任务与插件任务）。 */
export const BUILTIN_PLUGIN_ID = 'echo:main';

export const createTaskOwner = (id: string) => ({ id });

export const registerTask = (): void => notImplemented('registerTask');

export const createTaskLifecycleActions = (): never =>
  notImplemented('createTaskLifecycleActions');

export const invalidateTaskOwner = (): void => notImplemented('invalidateTaskOwner');
