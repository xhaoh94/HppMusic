#!/usr/bin/env node
/**
 * CSS 兼容性守卫（构建后检查）。
 *
 * ## 为什么需要
 *
 * 目标 WebView 基线是 **Chrome 110**（Android 12 上的系统 WebView 常见停在这里，
 * 而 minSdk 是 24，无法要求用户升级系统）。而 Tailwind 4 / 现代 CSS 大量使用
 * `color-mix()`（**Chrome 111**）—— 一旦写进产物，旧 WebView 上整条声明失效。
 *
 * 前身项目正是栽在这上面：主题变量里一百多处 color-mix 在 Android 12 上全部失效，
 * computed 值退化成 `#ffffff`，表现是「白底白字」——不报错、不崩溃，只是看不见。
 * 他们最终的补救是一个 546 行的 CSS 后处理器去手工展开 color-mix。
 *
 * 本项目从设计上避开这条路：**tokens.css 里一个 color-mix 都不用**，
 * 需要透明度就预先算好写成 rgba。这个脚本负责守住这个约定 ——
 * 任何时候有人（或某个依赖）把不兼容的语法带进产物，构建直接失败。
 *
 * 用法：node scripts/check-css-compat.mjs [dist目录]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist'));

/** 超过 Chrome 110 的特性：命中即失败 */
const BANNED = [
  { pattern: /color-mix\s*\(/g, feature: 'color-mix()', since: 'Chrome 111' },
  { pattern: /\boklch\s*\(/g, feature: 'oklch()', since: 'Chrome 111' },
  { pattern: /\boklab\s*\(/g, feature: 'oklab()', since: 'Chrome 111' },
  { pattern: /light-dark\s*\(/g, feature: 'light-dark()', since: 'Chrome 123' },
  { pattern: /text-wrap:\s*(balance|pretty)/g, feature: 'text-wrap: balance/pretty', since: 'Chrome 114' },
  { pattern: /@starting-style/g, feature: '@starting-style', since: 'Chrome 117' },
  { pattern: /field-sizing\s*:/g, feature: 'field-sizing', since: 'Chrome 123' },
  { pattern: /interpolate-size\s*:/g, feature: 'interpolate-size', since: 'Chrome 129' },
];

const collectCss = (dir) => {
  const out = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCss(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
};

const files = collectCss(DIST);
if (!files.length) {
  console.error(`[css-compat] 在 ${DIST} 下没找到任何 CSS —— 先跑 vite build`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  for (const { pattern, feature, since } of BANNED) {
    pattern.lastIndex = 0;
    const matches = code.match(pattern);
    if (matches?.length) {
      hits.push({
        file: path.relative(ROOT, file),
        feature,
        since,
        count: matches.length,
      });
    }
  }
}

console.log(`[css-compat] 检查 ${files.length} 个 CSS 文件（基线 Chrome 110）`);

if (hits.length) {
  console.error('\n[css-compat] 产物里出现了超出基线的 CSS 特性：\n');
  for (const hit of hits) {
    console.error(`  ✗ ${hit.file}`);
    console.error(`      ${hit.feature} —— ${hit.since} 才支持，命中 ${hit.count} 处`);
  }
  console.error(
    '\n[css-compat] 处理方式：\n' +
      '  · 需要透明度：预先算好写成 rgba(...)，不要用 color-mix\n' +
      '  · 需要响应式：用媒体查询，不要用 @container\n' +
      '  · 确实需要该特性：在 tokens.css 的基线说明里注明并评估影响面，再改这里的白名单\n',
  );
  process.exit(1);
}

console.log('[css-compat] 未发现超出基线的特性 ✅');
