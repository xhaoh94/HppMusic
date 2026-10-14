/**
 * 图标候选方案预览。
 *
 * 生成一张对比图：每个方案一行，按 192 / 96 / 48 三种尺寸排开 —— 只看大图会骗人，
 * 桌面图标实际是 48dp 上下，必须在小尺寸下也认得出。
 *
 * 用法：node scripts/dev/icon-options.mjs [输出路径]
 *
 * 设计上的取舍（都踩过）：
 * · **符头是斜椭圆**。音乐记谱里符头本来就带约 20° 倾角，画成水平椭圆会显得
 *   像"一根杆插了个球"，而不是音符。之前那版就是水平的。
 * · **内容占画布的 70% 上下**。太瘦（上一版只占 51% 宽）在桌面上看着空、没精神。
 * · **不用顶部那条钩形弧线**。它在小尺寸下会糊成一个点，还容易看成刘海。
 * · 底色和前景要有明确对比，不能两个都是中间调。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.argv[2] ?? path.join(ROOT, 'icon-options-preview.png');

const ACCENT = '#00F5D4';
const DARK = '#101014';

/**
 * 每个方案只写 `108×108` 画布内的内容；底色和裁切由外面统一加。
 *
 * 两条硬约束：
 * · **内容不超出中心 72×72**。自适应图标的前景安全区就是这么大，超出去会被
 *   launcher 的圆形/圆角遮罩切掉（这里按 67% = 72/108 反推坐标）。
 * · **符头是斜椭圆**（`rotate(-22)`）。音乐记谱里符头本来就带约 20° 倾角，
 *   画成水平椭圆会像"一根杆插了个球"，而不是音符 —— 上一版就是这么翻车的。
 *
 * 符头与符干的关系：符头**中心**比符干轴线左偏约一个 rx，让符头右沿刚好贴住符干。
 */
const DESIGNS = [
  {
    key: 'A',
    note: '单音符 · 青绿底白符',
    body: `
      <defs>
        <linearGradient id="ga" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2af5c8"/>
          <stop offset="1" stop-color="#00b894"/>
        </linearGradient>
      </defs>
      <rect width="108" height="108" fill="url(#ga)"/>
      <g fill="#ffffff">
        <rect x="60" y="18" width="11" height="58" rx="5.5"/>
        <ellipse cx="47" cy="72" rx="22" ry="15" transform="rotate(-22 47 72)"/>
      </g>`,
  },
  {
    key: 'B',
    note: '双音符 · 深底青绿',
    body: `
      <rect width="108" height="108" fill="${DARK}"/>
      <g fill="${ACCENT}">
        <rect x="40" y="20" width="9" height="56" rx="4.5"/>
        <rect x="78" y="20" width="9" height="56" rx="4.5"/>
        <rect x="40" y="20" width="47" height="11" rx="5.5"/>
        <ellipse cx="31.5" cy="74" rx="13" ry="10" transform="rotate(-22 31.5 74)"/>
        <ellipse cx="69.5" cy="74" rx="13" ry="10" transform="rotate(-22 69.5 74)"/>
      </g>`,
  },
  {
    key: 'C',
    note: '双音符 · 青绿底白符',
    body: `
      <defs>
        <linearGradient id="gc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2af5c8"/>
          <stop offset="1" stop-color="#00b894"/>
        </linearGradient>
      </defs>
      <rect width="108" height="108" fill="url(#gc)"/>
      <g fill="#ffffff">
        <rect x="40" y="20" width="9" height="56" rx="4.5"/>
        <rect x="78" y="20" width="9" height="56" rx="4.5"/>
        <rect x="40" y="20" width="47" height="11" rx="5.5"/>
        <ellipse cx="31.5" cy="74" rx="13" ry="10" transform="rotate(-22 31.5 74)"/>
        <ellipse cx="69.5" cy="74" rx="13" ry="10" transform="rotate(-22 69.5 74)"/>
      </g>`,
  },
  {
    key: 'D',
    note: '声波 · 品牌橙红底',
    body: `
      <defs>
        <linearGradient id="gd2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ff7a52"/>
          <stop offset="1" stop-color="#ff3a2a"/>
        </linearGradient>
      </defs>
      <rect width="108" height="108" fill="url(#gd2)"/>
      <g fill="#ffffff">
        <rect x="23" y="42" width="10" height="24" rx="5"/>
        <rect x="40" y="30" width="10" height="48" rx="5"/>
        <rect x="57" y="24" width="10" height="60" rx="5"/>
        <rect x="74" y="36" width="10" height="36" rx="5"/>
      </g>`,
  },
];

/** 模拟 Android 12 launcher 的圆角遮罩，否则预览比真机好看得虚 */
const cell = (key, body, index, size) => {
  const clip = `clip-${key}-${size}`;
  const scale = size / 108;
  return `<g>
    <defs><clipPath id="${clip}"><rect width="108" height="108" rx="24"/></clipPath></defs>
    <g clip-path="url(#${clip})" transform="scale(${scale})">${body}</g>
    <text x="${index}" y="${size + 18}" font-family="sans-serif" font-size="13" fill="#8b8b95">${key}</text>
  </g>`;
};

const SIZES = [192, 96, 48];
const GAP = 24;
const PAD = 28;
const ROW_GAP = 34;
const LABEL = 20;

const rowWidth = SIZES.reduce((sum, s) => sum + s, 0) + GAP * (SIZES.length - 1);
const width = PAD * 2 + rowWidth;
const rowHeight = Math.max(...SIZES) + LABEL;
const height = PAD * 2 + DESIGNS.length * rowHeight + (DESIGNS.length - 1) * ROW_GAP;

let y = PAD;
const rows = DESIGNS.map((design) => {
  let x = PAD;
  const cells = SIZES.map((size, index) => {
    const out = `<g transform="translate(${x} ${y})">${cell(design.key, design.body, index + 1, size)}</g>`;
    x += size + GAP;
    return out;
  }).join('');
  y += rowHeight + ROW_GAP;
  return cells;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#1a1a1e"/>
  ${rows}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`[icon-options] ${DESIGNS.length} 个方案 × ${SIZES.join('/')} → ${OUT}`);
