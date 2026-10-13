/**
 * 开发工具：列出某个渲染层目录里被引用的 KuGou 路由。
 *
 * 为什么需要它：`build-kugou-api.mjs` 是按「渲染层实际用到的路由」裁剪 module 的。
 * 本项目只 vendor 了渲染层的**内核子目录**（api/models/utils/stores/services），
 * 没有 views/components —— 于是需要在打包前确认：
 * 「只在桌面 views/components 里出现的路由」有没有被漏掉。
 *
 * 用法：
 *   node scripts/dev/scan-routes.mjs <目录>            # 打印该目录的路由
 *   node scripts/dev/scan-routes.mjs <目录A> <目录B>    # 打印 A 相对 B 的差集
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const ROUTE_RE = /request\.(?:get|post|put|delete)\(\s*['"](\/[^'"]+)['"]/g;

const scan = (dir) => {
  const routes = new Set();
  if (!dir || !statSync(dir, { throwIfNoEntry: false })) return routes;
  for (const file of walk(dir)) {
    if (!/\.(ts|vue)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    ROUTE_RE.lastIndex = 0;
    let match;
    while ((match = ROUTE_RE.exec(text))) routes.add(match[1]);
  }
  return routes;
};

const [dirA, dirB] = process.argv.slice(2);
if (!dirA) {
  console.error('用法：node scripts/dev/scan-routes.mjs <目录A> [目录B]');
  process.exit(1);
}

const a = scan(path.resolve(dirA));
if (!dirB) {
  console.log([...a].sort().join('\n'));
  console.log(`# 共 ${a.size} 个路由`);
  process.exit(0);
}

const b = scan(path.resolve(dirB));
const only = [...a].filter((route) => !b.has(route)).sort();
for (const route of only) console.log(route);
console.log(`# ${dirA} 有 ${a.size} 个，${dirB} 有 ${b.size} 个，仅前者有 ${only.length} 个`);
