/**
 * `@/plugins/runtime` 的桩实现（桌面插件运行时）。
 *
 * 本项目不做插件系统：上游的插件运行时建立在 Electron 主进程之上
 * （模块加载、IPC、tcp、任务面板、谱图订阅……），在 WebView 里没有对应能力。
 *
 * 内核里引用这个模块的只有两处，且都已被 `upstream.json` 的 exclude 排除：
 * · `stores/pluginUpdates.ts`
 * · `utils/rendererMemoryDiagnostics.ts`
 *
 * 也就是说 **P0 阶段没有任何代码会 import 到这里**。保留桩的目的有两个：
 * 1. 万一将来 vendor 了某个间接依赖它的内核文件，构建不会因为找不到模块而失败；
 * 2. 真的被调用时立刻抛错，而不是静默返回 undefined 让某个功能悄悄失效。
 */
import { reactive } from 'vue';

const notImplemented = (api: string): never => {
  throw new Error(
    `[stubs] 插件运行时未实现（${api}）。本项目不做插件系统；` +
      '若确有需要，请实现 src/stubs/plugins-runtime.ts 而不是改内核文件。',
  );
};

/** 上游用它做内存诊断；这里保持同形状的空状态。 */
export const pluginRuntimeState = reactive({
  loaded: [] as string[],
  active: [] as string[],
});

export const refreshPlugins = (): Promise<void> => notImplemented('refreshPlugins');

export const reloadOtherPluginRuntimes = (): Promise<void> =>
  notImplemented('reloadOtherPluginRuntimes');

export const waitForPluginRuntimeReady = (): Promise<void> => Promise.resolve();
