/**
 * 路由 meta 的类型增强。
 *
 * `shell` —— 是否显示移动端外壳（底部三栏 + 子页签）。默认 true；
 *            启动页、登录页、404 页设为 false（全屏，不带任何导航栏）。
 * `section` —— 分组标识。'main' 表示属于「主页」分区，顶部子页签栏
 *             只有在这一段路由下出现（对齐参考产品的信息架构）。
 * `title` —— 页面标题，用于外壳或原生侧展示。
 * `keepScroll` —— 返回该页时是否恢复上次滚动位置（默认 false）。
 */
import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    shell?: boolean;
    section?: 'main';
    title?: string;
    keepScroll?: boolean;
  }
}
