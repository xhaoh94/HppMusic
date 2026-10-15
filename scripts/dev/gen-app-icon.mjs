/**
 * 由 `logo-icon-only.png` 生成 Android 启动图标（各密度 PNG + 自适应图标的背景）。
 *
 * 用法：node scripts/dev/gen-app-icon.mjs
 *
 * ## 源文件就是设计稿，不要去"照着画"
 *
 * `logo-icon-only.png` 是用户提供的 logo 图形（800×600 白底、图形居中、约 176×175）。
 * 早先我试图用 SVG 的 path 数据手工重画，结果形状完全不对 —— 这个图形是
 * **深蓝圆环 + 环内一个深蓝音符**，音符的杆从圆顶向下接圆头，剩下的负空间
 * 是个不规则的逗号形。这种形状凭坐标猜是猜不出来的，只能取像素。
 *
 * 所以这里直接**从 PNG 裁出图形**，只负责按 Android 的规范重新排版。
 *
 * ⚠️ minSdk 是 24（低于 26），所以**不能只给自适应图标** ——
 * API 24/25 读的是 mipmap-<density>/ic_launcher.png，必须一并生成。
 *
 * ## 三个变体
 *
 * · `ic_launcher.png` / `ic_launcher_round.png` —— 白底 + 图形，占画布约 70%；
 * · `ic_launcher_foreground.png` —— **透明底** + 图形，占安全区（中心 72×72）约 89%。
 *   图形里的白色被抠成透明（只留深蓝），所以它和背景层合成后与方形图标一致；
 * · 背景层 —— `@color/ic_launcher_background`，就是白。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RES = path.join(ROOT, 'android/app/src/main/res');
const SOURCE = path.join(ROOT, 'logo-icon-only.png');

const PAPER = '#FFFFFF';

/** 源图里"非白即图形"的判定余量（留给抗锯齿边缘） */
const WHITE_CUTOFF = 240;

/**
 * 找图形的包围盒。
 *
 * 不硬编码坐标：换了设计稿就要改常数，而且改错了不会报错、只会静默裁歪。
 */
const findInkBbox = async (file) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      if (data[i] < WHITE_CUTOFF || data[i + 1] < WHITE_CUTOFF || data[i + 2] < WHITE_CUTOFF) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error(`${file} 里没找到非白像素，图形是不是全白？`);
  // 取正方形边长，避免非等比源图把图形拉伸
  const size = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const cx = Math.round((x0 + x1) / 2);
  const cy = Math.round((y0 + y1) / 2);
  return {
    left: Math.max(0, cx - Math.round(size / 2)),
    top: Math.max(0, cy - Math.round(size / 2)),
    size,
  };
};

const box = await findInkBbox(SOURCE);
console.log(`[app-icon] 源图图形包围盒 ${box.size}×${box.size} @ (${box.left},${box.top})`);

/** 裁出的图形（白底，未抠图） */
const inkCrop = () =>
  sharp(SOURCE).extract({ left: box.left, top: box.top, width: box.size, height: box.size });

/**
 * 把白色抠成透明，只留深蓝笔触。
 *
 * 用亮度做**平滑**过渡而不是二值化：二值化会把抗锯齿边缘切成硬边，缩到 48dp 后
 * 会看到一圈锯齿。深蓝的最亮通道是 97，白是 255，在两者之间线性映射 alpha。
 */
const transparentInk = async () => {
  const { data, info } = await inkCrop()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.alloc(width * height * 4);
  const LOW = 97;
  const HIGH = 255;
  for (let i = 0, o = 0; i < data.length; i += channels, o += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = Math.max(r, g, b);
    const t = Math.min(1, Math.max(0, (HIGH - lum) / (HIGH - LOW)));
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = Math.round(t * 255);
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

/**
 * 传统方形图标：图形占画布的约 72%（试过 80%，图形顶到边了）。
 * 注意这里的"画布"就是最终图标，没有自适应那层放大。
 *
 * 图形本身是**圆形**，所以占比可以给得比"方形内容"更高：被 launcher 的圆角
 * 遮罩切到的只是四角，而那四角在源图里本来就是空的。
 */
const LEGACY_INK_RATIO = 0.72;
/**
 * 自适应前景：只显示中心 72×72，而且 launcher 会把这 72dp **放大**到图标实际尺寸。
 *
 * 按 Android 规范，图形必须收在中心 66dp 的保证可见圆内（厂商遮罩比规范更激进，
 * 圆外内容会被切）。0.75 × 72 = 54dp，四边各留约 6dp，与主流应用的图标体量一致。
 */
const FOREGROUND_INK_RATIO = 0.75;

const CANVAS = 108;
const SAFE = 72;

const icon = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">${body}</svg>`;

/** density → 传统图标边长（dp 基准 48） */
const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
/** 自适应前景是 108dp 满画布 */
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

/** 图形居中叠到画布上 */
const place = (markUri, target, size) => {
  const offset = (size - target) / 2;
  return { input: markUri, left: Math.round(offset), top: Math.round(offset) };
};

const renderLegacy = async (outPath, size) => {
  const target = Math.round(size * LEGACY_INK_RATIO);
  const mark = await inkCrop().resize(target, target, { fit: 'contain', background: PAPER }).png().toBuffer();
  mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({
    create: { width: size, height: size, channels: 4, background: PAPER },
  })
    .composite([place(mark, target, size)])
    .png()
    .toFile(outPath);
};

const renderRound = async (outPath, size) => {
  const target = Math.round(size * LEGACY_INK_RATIO);
  const mark = await inkCrop().resize(target, target, { fit: 'contain', background: PAPER }).png().toBuffer();
  mkdirSync(path.dirname(outPath), { recursive: true });

  /**
   * 必须**分两步**：先把"白底 + 图形"合成成一张位图，再用圆形遮罩去 alpha。
   *
   * 把两次 composite 串在同一个 pipeline 里（第二个用 blend: 'dest-in'）时，
   * 实测输出是一张**纯白** —— 图形根本没被合上去，而且不报任何错。
   */
  const flat = await sharp({
    create: { width: size, height: size, channels: 4, background: PAPER },
  })
    .composite([place(mark, target, size)])
    .png()
    .toBuffer();

  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ffffff"/></svg>`,
  );
  await sharp(flat).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(outPath);
};

/**
 * 自适应前景：透明底 + 抠过图的图形。
 *
 * 用**目标像素尺寸**而不是 SVG 缩放：图形本身是位图，让 SVG 去缩放等于再插值一次，
 * 直接按目标尺寸 resize 出来的边缘更干净。
 */
const renderForeground = async (outPath, size) => {
  const target = Math.round((size * (SAFE / CANVAS) * FOREGROUND_INK_RATIO));
  const mark = await sharp(await transparentInk())
    .resize(target, target, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([place(mark, target, size)])
    .png()
    .toFile(outPath);
};

for (const [density, size] of Object.entries(LEGACY_SIZES)) {
  await renderLegacy(path.join(RES, `mipmap-${density}/ic_launcher.png`), size);
  await renderRound(path.join(RES, `mipmap-${density}/ic_launcher_round.png`), size);
}
for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
  await renderForeground(path.join(RES, `mipmap-${density}/ic_launcher_foreground.png`), size);
}

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
