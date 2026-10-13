/**
 * 主页分区顶部子页签的目录与持久化。
 *
 * 信息架构沿用参考产品：底部三栏固定，「主页」这一栏内部再放最多 3 个可自定义的
 * 页签。目录里**只登记已经实现的页面** —— 旧方案把一个 7 项的候选清单全列出来，
 * 点进去一半是空壳，用户会以为是坏了。
 */
import { computed, ref } from 'vue';

export interface HomeTab {
  key: string;
  title: string;
  path: string;
}

export const HOME_TAB_CATALOG: readonly HomeTab[] = [
  { key: 'home', title: '发现', path: '/main/home' },
  { key: 'explore', title: '探索', path: '/main/explore' },
];

export const MAX_HOME_TABS = 3;
const DEFAULT_TABS = ['home', 'explore'];
const STORAGE_KEY = 'hpp.homeTabs';

const readSavedTabs = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return DEFAULT_TABS;
    const keys = raw.filter((key): key is string => typeof key === 'string');
    // 只保留目录里存在的 + 去重：目录可能已经删掉了某个页签，残留配置不能带着死路由跑
    const valid = keys.filter(
      (key, index) => HOME_TAB_CATALOG.some((tab) => tab.key === key) && keys.indexOf(key) === index,
    );
    return valid.length ? valid.slice(0, MAX_HOME_TABS) : DEFAULT_TABS;
  } catch {
    return DEFAULT_TABS;
  }
};

export const homeTabKeys = ref<string[]>(readSavedTabs());

export const homeTabs = computed(() =>
  homeTabKeys.value
    .map((key) => HOME_TAB_CATALOG.find((tab) => tab.key === key))
    .filter((tab): tab is HomeTab => Boolean(tab)),
);

const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(homeTabKeys.value));
  } catch {
    /* 写不进去只影响下次启动的默认值 */
  }
};

/** 切换一个页签的启用状态；返回错误提示（成功则返回空串）。 */
export const toggleHomeTab = (key: string): string => {
  if (homeTabKeys.value.includes(key)) {
    if (homeTabKeys.value.length === 1) return '至少保留一个页签';
    homeTabKeys.value = homeTabKeys.value.filter((item) => item !== key);
    persist();
    return '';
  }
  if (homeTabKeys.value.length >= MAX_HOME_TABS) return `最多 ${MAX_HOME_TABS} 个，先取消一个再添加`;
  homeTabKeys.value = [...homeTabKeys.value, key];
  persist();
  return '';
};

export const resetHomeTabs = () => {
  homeTabKeys.value = [...DEFAULT_TABS];
  persist();
};
