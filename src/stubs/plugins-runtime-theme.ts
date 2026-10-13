/**
 * `@/plugins/runtime/theme` 的桩实现。
 *
 * 上游这个模块是**桌面插件运行时**的一部分：插件可以用它注册自定义表面配色，
 * 汇总结果写进 `legacySurfaceVariables`，再由 `stores/theme.ts` 合并进 CSS 变量。
 *
 * 本项目不做插件系统（桌面插件运行时依赖 Electron 主进程的能力），所以这里
 * 保持语义等价的最小实现：**没有任何插件贡献 → 永远是空对象**。
 * 上游 `stores/theme.ts` 只有一处引用（`Object.assign(base, legacySurfaceVariables.value)`），
 * 空对象即"没有额外变量"，行为与"零插件贡献"完全一致。
 *
 * 用别名而不是改内核文件：`scripts/sync-upstream.mjs` 会全量覆盖内核目录，
 * 只要有一个字节不同，每次同步都会冲突。
 */
import { shallowRef } from 'vue';

/** 插件注册的表面配色变量；无插件运行时，恒为空。 */
export const legacySurfaceVariables = shallowRef<Record<string, string>>({});

/** 插件注册的强调色渐变变量；无插件运行时，恒为空。 */
export const legacyAccentGradientVariables = shallowRef<Record<string, string>>({});
