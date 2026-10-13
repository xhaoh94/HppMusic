/**
 * `@/tasks/taskControl` 的桩实现。
 *
 * 上游用它承载「任务面板条目的打开/中止」跨组件状态。引用它的两个 store
 * （`cloudUpload` / `importTask`）已被 `upstream.json` 排除，P0 无调用方。
 */

const notImplemented = (api: string): never => {
  throw new Error(`[stubs] 任务控制未实现（${api}）。请实现 src/stubs/tasks-task-control.ts。`);
};

export interface TaskControlState<OpenMode extends string = 'detail'> {
  openRequested: boolean;
  abortRequested: boolean;
  mode: OpenMode | null;
}

export const createTaskControlState = <OpenMode extends string>(): TaskControlState<OpenMode> =>
  notImplemented('createTaskControlState');

export const activateTaskControl = (): void => notImplemented('activateTaskControl');

export const clearTaskControl = (): void => notImplemented('clearTaskControl');

export const finishTaskControl = (): void => notImplemented('finishTaskControl');

export const requestTaskOpen = (): void => notImplemented('requestTaskOpen');

export const consumeTaskOpen = (): boolean => notImplemented('consumeTaskOpen');

export interface RequestTaskAbortOptions {
  silent?: boolean;
}

export const requestTaskAbort = (): void => notImplemented('requestTaskAbort');
