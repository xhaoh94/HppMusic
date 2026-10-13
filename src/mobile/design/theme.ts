/**
 * 外观主题（深色 / 浅色 / 跟随系统）。
 *
 * 与内核的 `@/stores/theme`（桌面主题中心）刻意分开：
 * 那个 store 管的是壁纸、毛玻璃、面板不透明度、插件配色贡献等桌面专属概念，
 * 在手机上大半没有对应物。移动端只需要一件事 —— 切换 `data-theme`。
 *
 * 各处的颜色值都来自 tokens.css 的 `[data-theme='dark'|'light']` 块，
 * 所以换主题等于换一个属性，没有任何组件需要感知。
 */
import { ref, watch } from 'vue';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'hpp.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const readPreference = (): ThemePreference => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  } catch {
    /* 读不到就用默认值，不影响使用 */
  }
  return 'dark';
};

const media = typeof window !== 'undefined' ? window.matchMedia(DARK_QUERY) : null;
const systemDark = ref(media?.matches ?? true);

media?.addEventListener('change', (event) => {
  systemDark.value = event.matches;
});

export const themePreference = ref<ThemePreference>(readPreference());

export const resolvedTheme = ref<ResolvedTheme>('dark');

const resolve = (preference: ThemePreference): ResolvedTheme =>
  preference === 'system' ? (systemDark.value ? 'dark' : 'light') : preference;

const apply = (theme: ResolvedTheme) => {
  document.documentElement.dataset.theme = theme;
  // 状态栏/导航栏配色跟随（Capacitor SystemBars 读的是 windowBackground，
  // 这里同步 theme-color 让浏览器 UI 与页面一致，避免顶部出现一条异色）
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = theme === 'dark' ? '#0b0b0f' : '#f7f7f9';
  if (meta) meta.setAttribute('content', color);
  else {
    const created = document.createElement('meta');
    created.name = 'theme-color';
    created.content = color;
    document.head.appendChild(created);
  }
};

watch(
  [themePreference, systemDark],
  ([preference]) => {
    resolvedTheme.value = resolve(preference);
    apply(resolvedTheme.value);
  },
  { immediate: true },
);

export const setThemePreference = (preference: ThemePreference) => {
  themePreference.value = preference;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* 写不进去只是下次启动回到默认，不阻断本次切换 */
  }
};
