/**
 * 移动端图标表。
 *
 * 与内核无关，纯 UI 资源：只 import 真正用到的图标，避免把 5000+ 个 tabler 图标拖进包。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 为什么这里用 `import * as` + 手动解包，而不是 `import icon from '...'`
 *
 * `@iconify/icons-tabler/*` 是 **CommonJS** 模块，内容是
 *   `exports.__esModule = true; exports.default = { body: '...' }`
 *
 * 打包器对「CJS 的默认导出」有两套互不兼容的约定：
 *   · 认 `__esModule`（Babel/Node 语义）→ `import x` 得到 `{ body }` ✅
 *   · 不认（直接取 module.exports）    → `import x` 得到 `{ __esModule, default: { body } }` ❌
 *
 * 实测本项目的构建产物走的是后者，而且**又包了一层**，于是传给 `<Icon :icon>` 的是
 * 一个没有 `body` 的对象 —— Iconify 找不到图标，渲染出一个 `viewBox="0 0 16 16"`
 * 的**空 svg**。现象是「图标位置有占位、但什么都没有」，既不报错也不警告，
 * 排查时很容易误判成 CSS 问题（本项目就在这上面绕了一圈：
 * 直到在页面里读 `svg.__vueParentComponent.props.icon` 才看到真相）。
 *
 * 所以这里统一走 `unwrapIcon()`：逐层剥掉 `default` 直到拿到带 `body` 的对象。
 * 两种约定下都成立，不依赖任何打包器语义。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 新增图标时请在这里集中登记并起一个语义化别名（iconXxx），组件里不要直接
 * `import from '@iconify/icons-tabler/xxx'` —— 否则同一个图标很容易被引成两份，
 * 也看不出某个图标到底还在不在用。
 */
import type { IconifyIcon } from '@iconify/types';

import * as tablerAlertCircle from '@iconify/icons-tabler/alert-circle';
import * as tablerAlertTriangle from '@iconify/icons-tabler/alert-triangle';
import * as tablerArrowLeft from '@iconify/icons-tabler/arrow-left';
import * as tablerCheck from '@iconify/icons-tabler/circle-check';
import * as tablerChevronLeft from '@iconify/icons-tabler/chevron-left';
import * as tablerChevronRight from '@iconify/icons-tabler/chevron-right';
import * as tablerCircleX from '@iconify/icons-tabler/circle-x';
import * as tablerCloudOff from '@iconify/icons-tabler/cloud-off';
import * as tablerDeviceMobile from '@iconify/icons-tabler/device-mobile';
import * as tablerDisc from '@iconify/icons-tabler/disc';
import * as tablerDots from '@iconify/icons-tabler/dots';
import * as tablerHeadphones from '@iconify/icons-tabler/headphones';
import * as tablerHeart from '@iconify/icons-tabler/heart';
import * as tablerHistory from '@iconify/icons-tabler/history';
import * as tablerHome from '@iconify/icons-tabler/home';
import * as tablerInfoCircle from '@iconify/icons-tabler/info-circle';
import * as tablerList from '@iconify/icons-tabler/list';
import * as tablerLoader2 from '@iconify/icons-tabler/loader-2';
import * as tablerMusic from '@iconify/icons-tabler/music';
import * as tablerMusicOff from '@iconify/icons-tabler/music-off';
import * as tablerPause from '@iconify/icons-tabler/pause';
import * as tablerPlay from '@iconify/icons-tabler/play';
import * as tablerPlayerPause from '@iconify/icons-tabler/player-pause';
import * as tablerPlayerPlay from '@iconify/icons-tabler/player-play';
import * as tablerPlus from '@iconify/icons-tabler/plus';
import * as tablerRefresh from '@iconify/icons-tabler/refresh';
import * as tablerSearch from '@iconify/icons-tabler/search';
import * as tablerSettings from '@iconify/icons-tabler/settings';
import * as tablerShield from '@iconify/icons-tabler/shield';
import * as tablerSkipBack from '@iconify/icons-tabler/skip-back';
import * as tablerSkipForward from '@iconify/icons-tabler/skip-forward';
import * as tablerTrash from '@iconify/icons-tabler/trash';
import * as tablerUser from '@iconify/icons-tabler/user';
import * as tablerVolume from '@iconify/icons-tabler/volume';
import * as tablerWifiOff from '@iconify/icons-tabler/wifi-off';
import * as tablerX from '@iconify/icons-tabler/x';

/**
 * 剥掉 CJS 的 `default` 包装直到拿到真正的图标数据。
 *
 * 直接抛错而不是回落到空图标：图标是静态资源，这里的失败一定来自打包/依赖问题，
 * 应该在第一时间（开发或构建验证阶段）暴露，而不是上线后变成一排空白按钮。
 */
const unwrapIcon = (module: unknown, label: string): IconifyIcon => {
  let candidate: unknown = module;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as IconifyIcon).body === 'string'
    ) {
      return candidate as IconifyIcon;
    }
    const next = (candidate as { default?: unknown } | null)?.default;
    if (next === undefined || next === candidate) break;
    candidate = next;
  }
  throw new Error(
    `[icons] 无法从模块里取出图标数据：${label}。` +
      '多半是 @iconify/icons-tabler 的 CJS 导出形态变了，检查 scripts/check-icons.mjs。',
  );
};

const icon = (module: unknown, label: string) => unwrapIcon(module, label);

export const alertCircle = icon(tablerAlertCircle, 'alert-circle');
export const alertTriangle = icon(tablerAlertTriangle, 'alert-triangle');
export const arrowLeft = icon(tablerArrowLeft, 'arrow-left');
export const check = icon(tablerCheck, 'circle-check');
export const chevronLeft = icon(tablerChevronLeft, 'chevron-left');
export const chevronRight = icon(tablerChevronRight, 'chevron-right');
export const circleX = icon(tablerCircleX, 'circle-x');
export const cloudOff = icon(tablerCloudOff, 'cloud-off');
export const deviceMobile = icon(tablerDeviceMobile, 'device-mobile');
export const disc = icon(tablerDisc, 'disc');
export const dots = icon(tablerDots, 'dots');
export const headphones = icon(tablerHeadphones, 'headphones');
export const heart = icon(tablerHeart, 'heart');
export const history = icon(tablerHistory, 'history');
export const home = icon(tablerHome, 'home');
export const infoCircle = icon(tablerInfoCircle, 'info-circle');
export const list = icon(tablerList, 'list');
export const loader2 = icon(tablerLoader2, 'loader-2');
export const music = icon(tablerMusic, 'music');
export const musicOff = icon(tablerMusicOff, 'music-off');
export const pause = icon(tablerPause, 'pause');
export const play = icon(tablerPlay, 'play');
export const playerPause = icon(tablerPlayerPause, 'player-pause');
export const playerPlay = icon(tablerPlayerPlay, 'player-play');
export const plus = icon(tablerPlus, 'plus');
export const refresh = icon(tablerRefresh, 'refresh');
export const search = icon(tablerSearch, 'search');
export const settings = icon(tablerSettings, 'settings');
export const shield = icon(tablerShield, 'shield');
export const skipBack = icon(tablerSkipBack, 'skip-back');
export const skipForward = icon(tablerSkipForward, 'skip-forward');
export const trash = icon(tablerTrash, 'trash');
export const user = icon(tablerUser, 'user');
export const volume = icon(tablerVolume, 'volume');
export const wifiOff = icon(tablerWifiOff, 'wifi-off');
export const x = icon(tablerX, 'x');

/* ── 语义别名（组件里统一用这些名字，换图标只改这里） ── */
export const iconHome = home;
export const iconProfile = user;
export const iconUser = user;
export const iconPlay = playerPlay;
export const iconPause = playerPause;
export const iconMusic = music;
export const iconSearch = search;
export const iconSettings = settings;
export const iconBack = chevronLeft;
export const iconRefresh = refresh;
export const iconError = alertCircle;
export const iconWarning = alertTriangle;
export const iconSuccess = check;
export const iconClose = x;
export const iconSpinner = loader2;
export const iconPhone = deviceMobile;
export const iconShield = shield;
export const iconQueue = list;
export const iconNext = skipForward;
export const iconPrevious = skipBack;
export const iconInfo = infoCircle;
export const iconOffline = cloudOff;
export const iconNoNetwork = wifiOff;
export const iconRemove = trash;
export const iconAdd = plus;
export const iconMore = dots;
export const iconAlbum = disc;
export const iconHeadphones = headphones;
export const iconFavorite = heart;
export const iconHistory = history;
export const iconVolume = volume;
export const iconMusicOff = musicOff;
export const iconArrowLeft = arrowLeft;
export const iconArrowRight = chevronRight;
export const iconCircleX = circleX;
