/**
 * 由一份 SVG 生成 Android 启动图标（各密度 PNG + 自适应图标的背景）。
 *
 * 用法：node scripts/dev/gen-app-icon.mjs
 *       node scripts/dev/icon-options.mjs   # 看候选方案对比图
 *
 * ⚠️ minSdk 是 24（低于 26），所以**不能只给自适应图标** ——
 * API 24/25 读的是 mipmap-<density>/ic_launcher.png，必须一并生成。
 *
 * ## 设计来源
 *
 * 用户提供的 logo：深蓝色圆 + 镂空（负空间）的白色音符。原稿里还有
 * "音乐"两个大字和一行 "MUSIC"，按用户要求只保留图形部分 —— 图标在桌面上
 * 只有 48dp 上下，任何文字在那里都读不出来，应用名交给 launcher 显示。
 *
 * ## 三个变体的关系
 *
 * · `ic_launcher.png` / `ic_launcher_round.png` —— **完整图**（底色 + 图形），
 *   API 24/25 与不支持自适应的 launcher 用它；
 * · `ic_launcher_foreground.png` —— **透明底 + 图形**，26+ 的自适应图标把它
 *   和背景层合成，所以它自己绝不能带底色；
 * · 背景层 —— `@color/ic_launcher_background`，一个很浅的冷灰。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RES = path.join(ROOT, 'android/app/src/main/res');

/** 品牌色（取自用户提供的 logo） */
const INK = '#1C3B5D';
const PAPER = '#F2F5F8';

/**
 * 圆 + 镂空音符，以 (54, 54) 为中心、圆半径 38。
 *
 * 音符是**白色画在圆上**而不是真的挖空：白色和浅色底同色，视觉上就是镂空效果，
 * 但要简单可靠得多（真的挖空要走 mask，PNG 各密度的抗锯齿还会毛边）。
 *
 * 三个形状缺一不可（都对着原稿定过）：
 * · **符头**是正圆，不是斜椭圆 —— 原稿就是图标化的正圆，比记谱写法更适合小尺寸；
 * · **杆细**（9）且顶端 `y=16` 正好落在圆顶（54-38=16）上，把圆顶切开一个小口，
 *   这是原稿的特征。杆**不能**粗到像胶囊、也**不能**用圆角冒出去
 *   （用 rx 会把顶端做成圆弧，在透明前景层上会露到圆外）；
 * · **符尾**是音符的辨识特征，去掉之后"圆头 + 竖杆"会读成感叹号或胶囊。
 */
const disc = (r) => `<circle cx="54" cy="54" r="${r}" fill="${INK}"/>`;

/** 镂空音符：符头 + 杆 + 符尾。符尾要**粗短**（约杆长的 1/3），拉长了会读成钩子 */
const NOTE = `
    <g fill="#ffffff">
      <circle cx="45" cy="70" r="13"/>
      <rect x="53" y="16" width="9" height="56" rx="4.5"/>
    </g>
    <path d="M62 18 q-13 2 -13 14" stroke="#ffffff" stroke-width="9" fill="none" stroke-linecap="round"/>`;

/** 圆盘 + 音符，两者一起缩放（方形图标与自适应前景用） */
const MARK = `${disc(38)}${NOTE}`;

/**
 * 圆形图标：圆盘铺满画布，但**音符保持原大小**。
 * 跟着圆一起放大的话，音符会占满整个圆 —— 看起来就只是"一个大音符"，
 * 圆盘反而消失了。这里故意让两者的缩放不同。
 */
const ROUND_MARK = `${disc(54)}${NOTE}`;

/** 把整块图形缩放到目标占比，围绕圆心中缩放 —— 否则会越缩越偏 */
const markGroup = (scale) =>
  `<g transform="translate(54 54) scale(${scale}) translate(-54 -54)">${MARK}</g>`;

/**
 * 传统方形图标：图形按**画布**比例算，占约 70%（圆直径 76 / 108）。
 * 形状本身已按 108 画布设计好，所以这里 scale = 1。
 */
const LEGACY_SCALE = 1;

/**
 * 自适应前景：只显示中心 **72×72**，而且 launcher 会把这 72dp **放大**到
 * 图标实际尺寸 —— 所以内容占 108 画布的 x%，到桌面上看到的是 x/72。
 *
 * 圆直径 76 → 0.84 × 76 = 64，占安全区的 89%。圆形主体本来就该几乎占满安全区，
 * 留太多白会显得小气。
 */
const FOREGROUND_SCALE = 0.84;

const SHAPES = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">${body}</svg>`;

/** 方形完整图标：浅色纸底 + 图形 */
const squareIcon = (scale = LEGACY_SCALE) =>
  SHAPES(`<rect width="108" height="108" fill="${PAPER}"/>${markGroup(scale)}`);

/** 圆形完整图标：圆形纸底，四角透明。图形放大到刚好铺满这个圆 */
const roundIcon = () =>
  SHAPES(`
  <defs><clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="108" height="108" fill="${PAPER}"/>
    ${ROUND_MARK}
  </g>`);

/** 自适应图标前景：**透明底**，只有图形，缩放到安全区的约 89% */
const foregroundIcon = (scale = FOREGROUND_SCALE) => SHAPES(markGroup(scale));

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
 * 背景用**纯色**就够了（logo 本身就是双色：深蓝 + 浅底），
 * 所以回到 `@color`，不用上一版那套 `<aapt:attr>` 渐变。
 */
writeFileSync(
  path.join(RES, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/dev/gen-app-icon.mjs 生成，手改会被覆盖 -->
<resources>
    <color name="ic_launcher_background">${PAPER}</color>
</resources>
`,
);

const HEADER = `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/dev/gen-app-icon.mjs 生成，手改会被覆盖 -->
`;
for (const name of ['ic_launcher', 'ic_launcher_round']) {
  writeFileSync(
    path.join(RES, `mipmap-anydpi-v26/${name}.xml`),
    `${HEADER}<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`,
  );
}

console.log('[app-icon] 已生成 15 张 PNG + 背景色 + 2 个 anydpi 描述');
