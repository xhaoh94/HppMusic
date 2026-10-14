/**
 * 记住页面内部的滚动位置，切回来时恢复。
 *
 * ## 为什么 KeepAlive 不够
 *
 * `KeepAlive` 保住了组件实例（所以页面**不会重新拉数据**，这是我们要的），
 * 但**保不住滚动位置** —— 它把非活动组件的 DOM 从文档里移出，节点上的
 * `scrollTop` 随之丢失。实测：切走前 700，切回变 0。
 *
 * 而"从播放页返回后列表又跳回顶部"恰恰是最容易被察觉的退化 ——
 * 明明只是想回去接着看刚才那几首。
 *
 * ## 约定
 *
 * 页面内的滚动容器带 `.scroll-y` 类（全站统一的滚动约定，见 design/tokens.css）。
 * 这里取**当前路由页面里**的第一个匹配项，不用全局 querySelector，
 * 避免抓到已被 KeepAlive 缓存、仍在内存里的其它页面。
 */
import { nextTick, watch } from 'vue';
import type { Router } from 'vue-router';

/** 每个路由记住一个位置。用 Map 而不是挂在组件上：组件被 KeepAlive 缓存后依然拿不到跨页上下文 */
const positions = new Map<string, number>();

/**
 * 取当前可见页面里的滚动容器。
 *
 * 限定在 `.shell` 里再找：外壳之外（如全屏播放页）也有自己的滚动区，
 * 但那是另一个页面的事，不该互相污染。
 */
const currentScroller = (): HTMLElement | null => {
  const roots = [document.querySelector('.shell .scroll-y'), document.querySelector('.scroll-y')];
  for (const node of roots) {
    if (node instanceof HTMLElement) return node;
  }
  return null;
};

export const useKeepScroll = (router: Router) => {
  // 离开前记下：此时 DOM 还在文档里
  router.beforeEach((to, from) => {
    if (!from.name) return;
    const scroller = currentScroller();
    if (scroller) positions.set(String(from.name), scroller.scrollTop);
  });

  // 回来后恢复：必须等 nextTick —— DOM 刚刚重新插入，此刻量到的 scrollTop 还是 0
  watch(
    () => router.currentRoute.value.fullPath,
    async () => {
      const name = router.currentRoute.value.name;
      if (!name) return;
      const saved = positions.get(String(name));
      if (!saved) return;
      await nextTick();
      const scroller = currentScroller();
      if (scroller) scroller.scrollTop = saved;
    },
  );
};
