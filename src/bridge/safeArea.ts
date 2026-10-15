/**
 * 系统栏安全区（刘海 / 状态栏 / 导航栏）。
 *
 * ## 为什么需要前端主动来查一次
 *
 * 原生侧已经在 `onCreate` 和每次 insets 变化时把值注入成 `--safe-area-inset-*`，
 * 但那两次都可能打在**还没加载页面的 WebView** 上 —— JS 执行在 `about:blank` 上，
 * 页面一加载就没了。
 *
 * 实测踩过：重启 App 后 `--safe-area-inset-top` 直接**不存在**（不是 0，是没这个变量），
 * 于是 `--safe-top` 退回 0px，顶部内容被状态栏盖住。而"能用"的时候纯属运气 ——
 * 恰好有一次系统栏显隐触发了重新注入，且那时页面已经加载完了。
 *
 * 所以这里在页面脚本启动时主动查一次。两条路互补：不管 insets 先到还是页面先到，
 * 最终变量都会是对的。
 */

/** 原生侧注入的查询入口（见 MainActivity 的 SafeAreaQuery） */
interface SafeAreaHost {
  getInsets?: () => string;
}

interface Insets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

const host = (window as unknown as { HppSafeArea?: SafeAreaHost }).HppSafeArea;

/**
 * 把原生的 insets 写成 CSS 变量。
 *
 * 拿不到就静默放弃：CSS 里每个变量都有 `var(..., 0px)` 兜底，
 * 顶到状态栏也好过白屏或者抛错打断启动。
 */
export const applySafeAreaInsets = (): void => {
  if (!host?.getInsets) return;
  try {
    const insets = JSON.parse(host.getInsets()) as Insets;
    const style = document.documentElement.style;
    for (const key of ['top', 'bottom', 'left', 'right'] as const) {
      const value = insets[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        style.setProperty(`--safe-area-inset-${key}`, `${value}px`);
      }
    }
  } catch {
    // 见上：交给 CSS 的兜底值
  }
};
