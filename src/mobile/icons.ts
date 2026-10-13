/**
 * 移动端图标表。
 *
 * 与内核无关，纯 UI 资源：只 import 真正用到的图标，避免把 5000+ 个 tabler 图标拖进包。
 * 用 `@iconify/icons-tabler` 的**逐图标** 入口（不是 `@iconify/json` 全量），
 * 每个图标只占几百字节。
 *
 * ⚠️ 新增图标时请在这里集中登记并起一个语义化别名（iconXxx），组件里不要直接
 * `import from '@iconify/icons-tabler/xxx'` —— 否则同一个图标很容易被引成两份，
 * 也看不出某个图标到底还在不在用。
 */
import alertCircle from '@iconify/icons-tabler/alert-circle';
import alertTriangle from '@iconify/icons-tabler/alert-triangle';
import arrowLeft from '@iconify/icons-tabler/arrow-left';
import check from '@iconify/icons-tabler/circle-check';
import chevronLeft from '@iconify/icons-tabler/chevron-left';
import chevronRight from '@iconify/icons-tabler/chevron-right';
import circleX from '@iconify/icons-tabler/circle-x';
import cloudOff from '@iconify/icons-tabler/cloud-off';
import deviceMobile from '@iconify/icons-tabler/device-mobile';
import disc from '@iconify/icons-tabler/disc';
import dots from '@iconify/icons-tabler/dots';
import headphones from '@iconify/icons-tabler/headphones';
import heart from '@iconify/icons-tabler/heart';
import home from '@iconify/icons-tabler/home';
import infoCircle from '@iconify/icons-tabler/info-circle';
import list from '@iconify/icons-tabler/list';
import loader2 from '@iconify/icons-tabler/loader-2';
import music from '@iconify/icons-tabler/music';
import musicOff from '@iconify/icons-tabler/music-off';
import pause from '@iconify/icons-tabler/pause';
import play from '@iconify/icons-tabler/play';
import playerPause from '@iconify/icons-tabler/player-pause';
import playerPlay from '@iconify/icons-tabler/player-play';
import plus from '@iconify/icons-tabler/plus';
import refresh from '@iconify/icons-tabler/refresh';
import search from '@iconify/icons-tabler/search';
import settings from '@iconify/icons-tabler/settings';
import shield from '@iconify/icons-tabler/shield';
import skipBack from '@iconify/icons-tabler/skip-back';
import skipForward from '@iconify/icons-tabler/skip-forward';
import trash from '@iconify/icons-tabler/trash';
import user from '@iconify/icons-tabler/user';
import volume from '@iconify/icons-tabler/volume';
import wifiOff from '@iconify/icons-tabler/wifi-off';
import x from '@iconify/icons-tabler/x';

export {
  alertCircle,
  alertTriangle,
  arrowLeft,
  check,
  chevronLeft,
  chevronRight,
  circleX,
  cloudOff,
  deviceMobile,
  disc,
  dots,
  headphones,
  heart,
  home,
  infoCircle,
  list,
  loader2,
  music,
  musicOff,
  pause,
  play,
  playerPause,
  playerPlay,
  plus,
  refresh,
  search,
  settings,
  shield,
  skipBack,
  skipForward,
  trash,
  user,
  volume,
  wifiOff,
  x,
};

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
export const iconVolume = volume;
export const iconMusicOff = musicOff;
export const iconArrowLeft = arrowLeft;
export const iconArrowRight = chevronRight;
export const iconCircleX = circleX;
