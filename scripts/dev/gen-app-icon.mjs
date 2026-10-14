/**
 * 由一份 SVG 生成 Android 启动图标（各密度 PNG）。
 *
 * 为什么要脚本：图标有 5 个密度 × 3 个变体（普通/圆形/自适应前景）共 15 张 PNG，
 * 手改一次就得在别处重来一遍；下次调颜色/形状时只改这里的常量即可。
 *
 * 用法：node scripts/dev/gen-app-icon.mjs
 *
 * ⚠️ minSdk 是 24（低于 26），所以**不能只给自适应图标** ——
 * API 24/25 读的是 mipmap-<density>/ic_launcher.png，必须一并生成。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RES = path.join(ROOT, 'android/app/src/main/res');

/** 品牌色（用户给的音符色）与底色 */
const ACCENT = '#00F5D4';
const BACKDROP = '#171718';

/**
 * 音符本体。坐标来自用户提供的 SVG。
 *
 * ⚠️ **只有一个符头，挂在右边**。不要"好心"补左边那个 —— 两根符干各挂一只符头
 * 确实是常规画法（双八分音符），但用户的设计就是单符头；补上之后整体变成
 * "两个圆夹一根竖杆"的形状，用户明确否掉了。
 */
const NOTE = `
    <ellipse cx="70" cy="72" rx="10" ry="8"/>
    <rect x="46" y="38" width="4" height="36" rx="2"/>
    <rect x="58" y="38" width="4" height="36" rx="2"/>
    <rect x="46" y="52" width="16" height="4" rx="2"/>
    <!-- 顶部的弧：起点在左符干顶端，右端**比起点低 4**并向右探出右符干 6 —— 是钩形不是对称拱形 -->

    <path d="M48 38 Q58 28 66 42" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>`;

/**
 * 内容包围盒与几何中心。
 *
 * 因为符头只在右边，内容**天然偏右**（x 46→80，中心在 63 而不是 54），
 * 直接绕画布中心缩放会越缩越偏；所以先绕内容中心缩放，再把内容中心搬到画布中心。
 *
 * ⚠️ 纵向中心是 **56**，不要按“弧线顶点 y=30 再减描边”去算：
 * `Q58 30 66 38` 里的 30 是**控制点**，不等于曲线顶点。二次贝塞尔在 t=0.5 处的
 * 极值是 (38 + 2×30 + 38) / 4 = 34，再减掉描边半宽 2，上边才是 32；
 * 下边是符头 72 + 8 = 80。所以纵向中心 (32 + 80) / 2 = 56。
 * （按 54 生成的成品，像素包围盒实测整体偏下 3px。）
 */
const CONTENT_CENTER = { x: 63, y: 56 };

/** scale 用来把内容放大到目标占比（见下面几个 icon() 的默认值）。 */
const noteGroup = (scale) =>
  `<g transform="translate(54 54) scale(${scale}) translate(${-CONTENT_CENTER.x} ${-CONTENT_CENTER.y})" fill="${ACCENT}">${NOTE}</g>`;

/** 传统图标：内容占约 71%（实测；内容净高 32→80 = 48，×1.6 = 76.8 / 108） */
const squareIcon = (scale = 1.6) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <rect width="108" height="108" fill="${BACKDROP}"/>
  ${noteGroup(scale)}
</svg>`;

/** 圆形图标：底也是圆的，四角透明（比例与方形一致，否则同一台机器上两种图标一大一小） */
const roundIcon = (scale = 1.6) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs><clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath></defs>
  <circle cx="54" cy="54" r="54" fill="${BACKDROP}"/>
  <g clip-path="url(#c)">${noteGroup(scale)}</g>
</svg>`;

/**
 * 自适应图标前景：透明底，内容必须收在中心 72×72 安全区内（超出部分会被 launcher 裁掉）。
 * 1.4× → 净高 67.2，上下各留 20.4（安全区下限是 72/108 = 66.7%），已经是能用的上限。
 */
const foregroundIcon = (scale = 1.4) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  ${noteGroup(scale)}
</svg>`;

/** density → 传统图标边长（dp 基准 48） */
const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
/** 自适应前景是 108dp 满画布 */
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

const render = async (svg, size, outPath) => {
  mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
};

for (const [density, size] of Object.entries(LEGACY_SIZES)) {
  await render(squareIcon(), size, path.join(RES, `mipmap-${density}/ic_launcher.png`));
  await render(roundIcon(), size, path.join(RES, `mipmap-${density}/ic_launcher_round.png`));
}
for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
  await render(
    foregroundIcon(),
    size,
    path.join(RES, `mipmap-${density}/ic_launcher_foreground.png`),
  );
}

// 自适应图标的背景（26+ 用；渐变/纯色都行，这里与图标底一致）
writeFileSync(
  path.join(RES, 'drawable/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/dev/gen-app-icon.mjs 生成，手改会被覆盖 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportHeight="108"
    android:viewportWidth="108">
    <path android:fillColor="${BACKDROP}" android:pathData="M0,0h108v108h-108z" />
</vector>
`,
);
writeFileSync(
  path.join(RES, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/dev/gen-app-icon.mjs 生成，手改会被覆盖 -->
<resources>
    <color name="ic_launcher_background">${BACKDROP}</color>
</resources>
`,
);

console.log('[app-icon] 已生成 15 张 PNG + 背景色');
