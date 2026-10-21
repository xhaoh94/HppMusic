/**
 * 无限滚动列表。
 *
 * 移动端几乎每个列表页都需要它（搜索结果、歌单详情、专辑、歌手作品……），
 * 所以抽成一个 composable，而不是每个页面各写一遍 —— 各写一遍必然出现
 * 「有的页面能重试、有的不能」「有的页面到底了还在转圈」这类不一致。
 *
 * 设计要点：
 *
 * 1. **哨兵元素 + IntersectionObserver**，而不是监听 scroll 事件。
 *    scroll 事件每帧都触发，要自己做节流与"到底了没"的几何计算；
 *    IntersectionObserver 由浏览器在真正接近视口时回调，零 scroll 监听。
 *
 * 2. **请求代际（generation）**：用户连续改关键词时，旧请求可能后到。
 *    每次 reload 递增代际，回来时代际不符就丢弃 —— 否则会出现
 *    「搜 A 显示 A、再搜 B 又闪回 A」这种竞态。
 *
 * 3. **同一页不重复请求**：`inFlight` 与 `hasMore` 双重判断。
 *    哨兵在加载期间仍可见时，observer 会连续回调，没有这个判断会打出一串重复请求。
 *
 * 4. **错误可重试且不丢已加载内容**：失败只置 error，保留 items，
 *    用户点重试继续加载下一页，而不是回到空列表从头再来。
 */
import { computed, nextTick, ref, watch, type Ref } from 'vue';

export interface InfiniteListLoader<T> {
  (page: number): Promise<{ items: T[]; hasMore: boolean; total?: number | null }>;
}

export interface UseInfiniteListOptions {
  /** 首屏就自动加载（默认 true） */
  immediate?: boolean;
  /** 距离哨兵多少像素开始预加载；留一屏余量，滚动到底时内容已就绪 */
  rootMargin?: string;
}

export const useInfiniteList = <T>(
  loader: InfiniteListLoader<T>,
  options: UseInfiniteListOptions = {},
) => {
  const items = ref<T[]>([]) as Ref<T[]>;
  const page = ref(0);
  const total = ref<number | null>(null);
  const hasMore = ref(true);

  const isLoading = ref(false);
  const isLoadingMore = ref(false);
  const error = ref('');

  const sentinel = ref<HTMLElement | null>(null);
  /** 每次 reload 递增；异步回来时代际不符就丢弃结果 */
  let generation = 0;
  /** 上一页实际追加了多少条：为 0 时不能再自动继续（否则空页会死循环） */
  let lastPageAdded = 0;

  const isEmpty = computed(() => !isLoading.value && !error.value && items.value.length === 0);

  /**
   * 哨兵仍在视口内就继续拉下一页。
   *
   * `IntersectionObserver` 只在相交状态**变化**时回调：追加的一页若没把哨兵
   * 推出视口（末页只剩 1~2 行、平板/横屏高视口），它会一直“相交中”，
   * 之后再也不会触发 —— 自动加载就停在那里。这里在每次加载结束后重新量一次。
   */
  const continueIfSentinelVisible = async () => {
    if (!hasMore.value || error.value || lastPageAdded === 0) return;
    await nextTick();
    const element = sentinel.value;
    if (!element) return;
    if (element.getBoundingClientRect().top > window.innerHeight + 240) return;
    void loadMore();
  };

  const run = async (targetPage: number, mode: 'replace' | 'append') => {
    if (isLoading.value || isLoadingMore.value) return;
    if (mode === 'append' && !hasMore.value) return;

    const currentGeneration = generation;
    if (mode === 'replace') isLoading.value = true;
    else isLoadingMore.value = true;
    error.value = '';

    try {
      const result = await loader(targetPage);
      if (currentGeneration !== generation) return;

      items.value = mode === 'replace' ? result.items : [...items.value, ...result.items];
      page.value = targetPage;
      hasMore.value = result.hasMore;
      total.value = result.total ?? null;
      lastPageAdded = result.items.length;
    } catch (caught) {
      if (currentGeneration !== generation) return;
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (currentGeneration === generation) {
        isLoading.value = false;
        isLoadingMore.value = false;
        void continueIfSentinelVisible();
      }
    }
  };

  /** 从第一页重新加载 */
  const reload = () => {
    generation += 1;
    items.value = [];
    page.value = 0;
    total.value = null;
    hasMore.value = true;
    error.value = '';
    isLoading.value = false;
    isLoadingMore.value = false;
    lastPageAdded = 0;
    return run(1, 'replace');
  };

  /** 加载下一页 */
  const loadMore = () => {
    if (!hasMore.value || isLoading.value || isLoadingMore.value || error.value) return;
    return run(page.value + 1, 'append');
  };

  /** 失败后继续加载（已加载内容保留；首屏失败则从第一页重来） */
  const retry = () => {
    if (!error.value) return reload();
    error.value = '';
    // ⚠️ 首屏失败时 page 还是 0：必须走 replace。走 append 只会置 isLoadingMore，
    // 而 isEmpty 只看 isLoading / error，重试请求期间会瞬间变成 true ——
    // 界面从“加载失败”闪成“还没有内容”，用户以为数据被清了。
    return page.value === 0 ? run(1, 'replace') : run(page.value + 1, 'append');
  };

  /**
   * 哨兵观察。
   *
   * 用 watch 而不是 onMounted：哨兵由 `v-if` 控制（首屏加载中不渲染），
   * 挂载时机不确定；watch 在它真正出现时才建立观察。
   */
  watch(sentinel, (element, _previous, onCleanup) => {
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: options.rootMargin ?? '240px' },
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  if (options.immediate !== false) {
    void reload();
  }

  return {
    items,
    total,
    hasMore,
    isLoading,
    isLoadingMore,
    isEmpty,
    error,
    page,
    sentinel,
    reload,
    loadMore,
    retry,
  };
};
