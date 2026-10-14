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
 * 用户提供的 logo：**深蓝圆盘，内部挖掉一个白色内孔，孔里再放一个深蓝音符。**
 * 原稿里还有「音乐」两个大字和一行「MUSIC」—— 图标在桌面上只有 48dp 上下，
 * 任何文字在那里都读不出来，所以只保留图形，名字交给 launcher 显示。
 *
 * ⚠️ 这一版的形状**返工过一次**，第一次理解反了：
 * 做成了"实心深蓝圆 + 白色音符画在上面"，但原稿是"挖空的圆 + 深蓝音符"。
 * 区别在圆到底是一个**环**还是一个**实心盘** —— 一眼就能看出不同。
 *
 * ## 内孔是"真挖穿"，不是画个白圆
 *
 * 画个和背景同色的白圆看起来也能出效果，但 `ic_launcher_foreground.png` 是
 * **透明底**的：那里画白圆会得到一块不透明的浅色，叠在自适应图标的背景层上
 * 就显出一圈色差。
 *
 * 实现用"外圆 + 内孔"两条子路径配 `fill-rule="evenodd"`，音符再作为独立元素填回孔里。
 * 比 `<mask>` 少一层 defs 和 id 管理（一份 SVG 里多个变体时 id 还容易撞），
 * 而且这个写法在浏览器和 librsvg 上行为一致。
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
 * 图形本体：外圆 r=38，内孔 r=23（圆环厚 15，约占半径 39%），孔里是深蓝音符。
 *
 * 音符的三个部分（对着原稿定的）：
 * · **符头是正圆**（不是记谱那种斜椭圆）—— 原稿就是图标化的正圆；
 * · **杆细**（9），从内孔上部往下接到符头；
 * · **符尾**从杆顶向右下弯一小段（约杆长的 1/3）—— 少了它"圆头 + 竖杆"
 *   会读成感叹号，拉长了又读成钩子。
 *
 * 音符在内孔里**略偏左**：符尾占掉右上角，视觉重心靠左反而更稳。
 */
const MARK = `
  <path fill-rule="evenodd" fill="${INK}" d="
    M16,54 a38,38 0 1,0 76,0 a38,38 0 1,0 -76,0 Z
    M31,54 a23,23 0 1,0 46,0 a23,23 0 1,0 -46,0 Z"/>
  <g fill="${INK}">
    <circle cx="45" cy="68" r="11"/>
    <rect x="52" y="28" width="9" height="42" rx="4.5"/>
  </g>
  <path d="M61 28 q13 4 13 18" stroke="${INK}" stroke-width="9" fill="none" stroke-linecap="round"/>`;

/** 把整块图形缩放到目标占比，围绕圆心缩放 —— 否则会越缩越偏 */
const markGroup = (scale) =>
  `<g transform="translate(54 54) scale(${scale}) translate(-54 -54)">${MARK}</g>`;

/**
 * 传统方形图标：图形按**画布**比例算，占约 70%（外圆直径 76 / 108）。
 * 形状本身已按 108 画布设计好，所以这里 scale = 1。
 */
const LEGACY_SCALE = 1;

/**
 * 自适应前景：只显示中心 **72×72**，而且 launcher 会把这 72dp **放大**到
 * 图标实际尺寸 —— 所以内容占 108 画布的 x%，到桌面上看到的是 x/72。
 *
 * 0.84 × 76 = 64，占安全区的 89%。圆形主体本来就该几乎占满安全区。
 */
const FOREGROUND_SCALE = 0.84;

/**
 * 圆形图标：外圆要铺满整个 108 画布，所以 38 → 54，放大 1.42 倍。
 * 这里是**整块图形**一起放大（内孔和音符跟着走）—— 它们本来就是同一个 logo，
 * 不像上一版那样需要在圆盘和音符之间区分缩放。
 */
const ROUND_SCALE = 54 / 38;

const SHAPES = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">${body}</svg>`;

/** 方形完整图标：浅色纸底 + 图形 */
const squareIcon = (scale = LEGACY_SCALE) =>
  SHAPES(`<rect width="108" height="108" fill="${PAPER}"/>${markGroup(scale)}`);

/** 圆形完整图标：圆形纸底，四角透明。图形放大到刚好铺满这个圆 */
const roundIcon = (scale = ROUND_SCALE) =>
  SHAPES(`
  <defs><clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="108" height="108" fill="${PAPER}"/>
    ${markGroup(scale)}
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

/** 背景用纯色就够了（logo 本身是双色） */
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
