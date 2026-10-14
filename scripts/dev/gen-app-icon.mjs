/**
 * 由一份 SVG 生成 Android 启动图标（各密度 PNG + 自适应图标的背景）。
 *
 * 用法：node scripts/dev/gen-app-icon.mjs
 *       node scripts/dev/icon-options.mjs   # 看候选方案对比图
 *
 * ⚠️ minSdk 是 24（低于 26），所以**不能只给自适应图标** ——
 * API 24/25 读的是 mipmap-<density>/ic_launcher.png，必须一并生成。
 *
 * ## 为什么是脚本而不是手改 15 张 PNG
 *
 * 图标有 5 个密度 × 3 个变体，手改一次下次调色就得重来一遍。这里只维护
 * 一份 `108×108` 的坐标，其余全由它推导。
 *
 * ## 三个变体的关系
 *
 * · `ic_launcher.png` / `ic_launcher_round.png` —— **完整图**（底色 + 音符），
 *   API 24/25 与不支持自适应的 launcher 用它；
 * · `ic_launcher_foreground.png` —— **透明底 + 音符**，26+ 的自适应图标把它
 *   和背景层合成，所以它自己绝不能带底色；
 * · 背景层 —— `drawable/ic_launcher_background.xml` 里的渐变，由 anydpi 的
 *   xml 引用。用 drawable 而不是 color，因为渐变没法塞进一个颜色值。
 *
 * ## 安全区
 *
 * 自适应图标只显示中心 **72×72**，超出去会被 launcher 的圆形/圆角遮罩切掉。
 * 所以音符的坐标是按"内容不超出 [18, 90]"反推的，不要随手放大。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RES = path.join(ROOT, 'android/app/src/main/res');

/**
 * 双八分音符（方案 C）。
 *
 * 两条来自实际返工的经验：
 * · **符头是斜的**（`rotate(-22)`）。音乐记谱里符头本来就带约 20° 倾角；
 *   画成水平椭圆会像"一根杆插了个球"，完全不像音符（前一版就是这么翻车的）。
 * · **符头是扁的**（rx 13 / ry 10）。做成正圆会变成两个球。符头**中心**比符干
 *   轴线左偏约一个 rx，让符头右沿刚好贴住符干。
 */
const NOTE = `
    <g fill="#ffffff">
      <rect x="41" y="22" width="9" height="56" rx="4.5"/>
      <rect x="79" y="22" width="9" height="56" rx="4.5"/>
      <rect x="41" y="22" width="47" height="11" rx="5.5"/>
      <ellipse cx="32.5" cy="76" rx="13" ry="10" transform="rotate(-22 32.5 76)"/>
      <ellipse cx="70.5" cy="76" rx="13" ry="10" transform="rotate(-22 70.5 76)"/>
    </g>`;

/** 品牌底色：青绿渐变，与图标里的白色音符对比足够强 */
const BACKDROP_FROM = '#2af5c8';
const BACKDROP_TO = '#00b894';
/** 同样的渐变，但写成 SVG defs（PNG 用） */
const backdropDefs = (id) => `
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BACKDROP_FROM}"/>
        <stop offset="1" stop-color="${BACKDROP_TO}"/>
      </linearGradient>
    </defs>`;

/** 方形完整图标 */
const squareIcon = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  ${backdropDefs('bg')}
  <rect width="108" height="108" fill="url(#bg)"/>
  ${NOTE}
</svg>`;

/** 圆形完整图标：底也是圆的，四角透明 */
const roundIcon = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  ${backdropDefs('bgr')}
  <defs><clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath></defs>
  <circle cx="54" cy="54" r="54" fill="url(#bgr)"/>
  <g clip-path="url(#c)">${NOTE}</g>
</svg>`;

/**
 * 自适应图标前景：**透明底**，只放音符。
 * 内容已经在中心 72×72 内，所以这里 scale = 1，不要再放大。
 */
const foregroundIcon = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  ${NOTE}
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

/**
 * 背景层用 **drawable 渐变**而不是 `@color`。
 *
 * 渐变塞不进一个颜色值；`<aapt:attr>` 是在 vector 里内联 gradient 的标准写法。
 * 注意 anydpi 的 xml 引用的是 `@drawable/ic_launcher_background`（不是 `@color`），
 * 所以原来那个 `values/ic_launcher_background.xml` 已经没人引用了，一并删掉。
 */
const HEADER = `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/dev/gen-app-icon.mjs 生成，手改会被覆盖 -->
`;
writeFileSync(
  path.join(RES, 'drawable/ic_launcher_background.xml'),
  `${HEADER}<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0"
                android:startY="0"
                android:endX="108"
                android:endY="108">
                <item android:offset="0" android:color="${BACKDROP_FROM.toUpperCase().replace('#', '#FF')}" />
                <item android:offset="1" android:color="${BACKDROP_TO.toUpperCase().replace('#', '#FF')}" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`,
);

for (const name of ['ic_launcher', 'ic_launcher_round']) {
  writeFileSync(
    path.join(RES, `mipmap-anydpi-v26/${name}.xml`),
    `${HEADER}<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`,
  );
}

console.log('[app-icon] 已生成 15 张 PNG + 渐变背景 + 2 个 anydpi 描述');
