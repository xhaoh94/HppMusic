/**
 * 桌面布局形状的桩。
 *
 * 内核的 `stores/setting.ts` 在用三个工厂函数初始化三段桌面布局状态：
 *
 * ```ts
 * import { emptyTitlebarLayout } from '../plugins/titlebar';
 * import { emptyPlayerBarLayout } from '../layouts/playerBarActions';
 * import { emptySidebarLayout } from '../layouts/sidebarLayout';
 * ```
 *
 * 这三个模块属于**桌面外壳**（标题栏按钮区 / 播放器底栏 / 侧边栏），
 * 移动端不 vendor。已核实：整个内核里除了 `setting.ts` 这三行赋值之外，
 * **没有任何文件读取过 `settingStore.titlebarLayout / playerBarLayout / sidebarLayout`**
 * —— 它们纯粹是桌面端「用户自定义布局」的存储位。
 *
 * 所以这里提供形状等价的空实现：结构、字段名、默认值都与上游一致，
 * 以后若真有内核代码读它们，拿到的也是一个合法的空布局，不会崩。
 *
 * ⚠️ 这三个是**相对路径**导入（`../plugins/...`），没法用 vite alias 按
 * 模块路径重定向 —— 同一个字符串在不同目录含义不同。所以改由
 * `scripts/sync-upstream.mjs` 的 `rewrites` 规则在复制后定点替换，
 * 规则写在 upstream.json 里，上游改动导致锚点消失时会直接报错。
 */

export interface TitlebarLayout {
  placements: Record<string, string>;
  order: string[];
}

export interface PlayerBarLayout {
  placements: Record<string, string>;
  order: string[];
  badges: Record<string, string>;
}

export interface SidebarLayout {
  sectionOrder: string[];
  itemOrder: Record<string, string[]>;
  hiddenSections: Record<string, boolean>;
  hiddenItems: Record<string, boolean>;
  railSections: Record<string, boolean>;
}

export const emptyTitlebarLayout = (): TitlebarLayout => ({ placements: {}, order: [] });

export const emptyPlayerBarLayout = (): PlayerBarLayout => ({
  placements: {},
  order: [],
  badges: {},
});

export const emptySidebarLayout = (): SidebarLayout => ({
  sectionOrder: [],
  itemOrder: {},
  hiddenSections: {},
  hiddenItems: {},
  railSections: {},
});
