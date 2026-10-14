/**
 * 移动端路由。
 *
 * 与桌面路由（`@/router`）完全独立：桌面那套带着 `/mini-player`、`/main/themes`、
 * 插件页、`/main/settings/plugins` 这些 Android 上不存在的入口，且布局挂在
 * `MainLayout`（侧边栏 + 主工作区）下。这里重建一份扁平的移动端路由。
 *
 * 页面一律**懒加载**：首屏只需要启动页与登录页，其余按需拉取，
 * 冷启动不必为 20 个页面付解析代价（内核 + KuGou API 打包产物本身已 1.4MB）。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { pinia } from '@mobile/store';

/**
 * 用 hash 路由：Capacitor 的 WebView 以 `https://localhost` 提供静态文件，
 * history 模式下深链接（分享链接、`echomusic://` scheme 唤起）需要原生侧配合
 * 把所有路径回退到 index.html；hash 模式零配置且刷新不 404。
 * 原生 MainActivity 的返回键处理也是按 WebView 历史（hash 变更同样入历史）后退的。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'loading',
      component: () => import('@mobile/features/loading/LoadingPage.vue'),
      meta: { shell: false },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@mobile/features/login/LoginPage.vue'),
      meta: { shell: false },
    },

    // ── 主页分区：顶部子页签栏只在这一段路由下出现 ──
    {
      path: '/main',
      redirect: { name: 'home' },
    },
    {
      path: '/main/home',
      name: 'home',
      component: () => import('@mobile/features/home/HomePage.vue'),
      meta: { section: 'main', title: '发现' },
    },
    {
      path: '/main/explore',
      name: 'explore',
      component: () => import('@mobile/features/explore/ExplorePage.vue'),
      meta: { section: 'main', title: '探索' },
    },
    {
      path: '/main/free-listen',
      name: 'free-listen',
      component: () => import('@mobile/features/free-listen/FreeListenPage.vue'),
      meta: { section: 'main', title: '免费听' },
    },

    // ── 全屏页（不带外壳） ──
    {
      path: '/player',
      name: 'player',
      component: () => import('@mobile/features/player/PlayerPage.vue'),
      meta: { shell: false, title: '正在播放' },
    },

    // ── 独立页面 ──
    {
      path: '/search',
      name: 'search',
      component: () => import('@mobile/features/search/SearchPage.vue'),
      meta: { title: '搜索' },
    },

    // ── 首页磁贴的落地页 ──
    {
      path: '/recommend',
      name: 'recommend',
      component: () => import('@mobile/features/recommend/RecommendPage.vue'),
      meta: { title: '每日推荐' },
    },
    {
      path: '/ranking',
      name: 'ranking',
      component: () => import('@mobile/features/ranking/RankingPage.vue'),
      meta: { title: '排行榜' },
    },
    {
      path: '/rank/:id',
      name: 'rank-detail',
      component: () => import('@mobile/features/ranking/RankDetailPage.vue'),
      meta: { title: '榜单' },
    },
    {
      path: '/recognize',
      name: 'recognize',
      component: () => import('@mobile/features/recognize/RecognizePage.vue'),
      meta: { title: '听歌识曲' },
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@mobile/features/profile/ProfilePage.vue'),
      meta: { title: '我的' },
    },
    {
      path: '/favorites',
      name: 'favorites',
      component: () => import('@mobile/features/favorites/FavoritesPage.vue'),
      meta: { title: '我的收藏' },
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@mobile/features/history/HistoryPage.vue'),
      meta: { title: '播放历史' },
    },
    {
      path: '/my-playlists',
      name: 'my-playlists',
      component: () => import('@mobile/features/my-playlists/MyPlaylistsPage.vue'),
      meta: { title: '我的歌单' },
    },

    // ── 详情页 ──
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('@mobile/features/detail/PlaylistDetailPage.vue'),
      meta: { title: '歌单' },
    },
    {
      path: '/album/:id',
      name: 'album',
      component: () => import('@mobile/features/detail/AlbumDetailPage.vue'),
      meta: { title: '专辑' },
    },
    {
      path: '/artist/:id',
      name: 'artist',
      component: () => import('@mobile/features/detail/ArtistDetailPage.vue'),
      meta: { title: '歌手' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@mobile/features/settings/SettingsPage.vue'),
      meta: { title: '设置' },
    },

    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@mobile/features/not-found/NotFoundPage.vue'),
      meta: { shell: false },
    },
  ],
});

/**
 * 未登录不放行主界面。
 *
 * 手机上没有第二台设备能扫自己屏幕上的登录二维码，所以登录是使用前提。
 *
 * ⚠️ 三个必须的处理（沿用 EchoMusic 移动端的结论，不是抄代码而是抄教训）：
 *
 * 1. **先创建 store，再等水合** —— `useUserStore()` 是首次创建 user store 的地方，
 *    它的异步水合此刻才被注册进 hydrationPromises。如果先
 *    `await waitForSqlitePersistHydration()` 再创建，等的是一个还没注册的空集合，
 *    于是读到 isLoggedIn 的初始值 false —— 已登录用户每次冷启动都被弹到登录页。
 * 2. **放行启动页与登录页本身** —— 启动页要跑设备注册（登录的前置），
 *    登录页靠自己的流程导航。拦了会形成「跳登录页 → 回启动页」的循环。
 * 3. **用 replace 跳登录页** —— 历史里不留中间态；否则按返回键会退到登录页，
 *    而未登录时登录页又立刻反弹，用户按几次都退不出去。
 */
router.beforeEach(async (to) => {
  if (to.name === 'loading' || to.name === 'login') return true;

  const [{ useUserStore }, { waitForSqlitePersistHydration }] = await Promise.all([
    import('@/stores/user'),
    import('@/stores/sqlitePersist'),
  ]);

  const user = useUserStore(pinia);
  await waitForSqlitePersistHydration();
  if (user.isLoggedIn) return true;

  return { name: 'login', replace: true };
});
