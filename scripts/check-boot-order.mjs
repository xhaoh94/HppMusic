#!/usr/bin/env node
/**
 * 启动顺序守卫（构建后检查）。
 *
 * ## 守的是什么
 *
 * 内核里有一批模块在**模块初始化时**就抓 `window.electron.*`：
 *   · `@/utils/logger`  → `window.electron.log`
 *   · `@/utils/player`  → `window.electron.player`
 *
 * 而 ESM 的求值顺序是：**chunk 的静态 import 先于入口模块体**。
 * 所以只要"内核模块"出现在入口 chunk 的静态依赖里，它们就一定在
 * `main.ts` 的 `initApiBridge()` 之前被求值 —— 抓到的永远是 undefined，
 * **而且不报错**：日志静默退化成 console，播放能力则完全失效。
 *
 * 这类 bug 靠 review 守不住（"往 main.ts 加个 import"看起来完全无害），
 * 必须在产物上机械判定。
 *
 * ## 判定方式
 *
 * 读 `dist/build-manifest.json`（由 vite.config.ts 的 buildManifest 插件输出，
 * 记录每个 chunk 里实际装了哪些源文件），从入口 chunk 出发沿**静态** imports
 * 做闭包，任何一步碰到 `src/renderer/**`（generated 除外）或 `src/main/**` 即失败。
 *
 * 动态 import 不算违规 —— 它们在 `initApiBridge()` 之后才被加载，这正是设计意图。
 *
 * 用法：node scripts/check-boot-order.mjs [dist目录]
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist'));
const MANIFEST = path.join(DIST, 'build-manifest.json');

if (!existsSync(MANIFEST)) {
  console.error(`[boot-order] 找不到 ${MANIFEST} —— 先跑 vite build`);
  process.exit(1);
}

const { chunks } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));

/**
 * 必须在桥之后才能加载的模块。
 *
 * 判定依据不是「属于哪个目录」，而是**会不会在模块初始化时抓 window.electron**：
 * 抓了就必须动态加载。目前已知会抓的有：
 *   · src/renderer/utils/logger.ts  → const electronLog = getElectronLog()
 *   · src/renderer/utils/player.ts  → 模块级取 window.electron.player
 * 两者都在内核目录下，所以整块内核都不允许进静态闭包 —— 这是最省心的划法，
 * 新增内核模块时不需要再评估。
 *
 * 找这类模块的方法：
 *   grep -rn "window\.electron" src/renderer
 * 再人工判断哪些命中落在函数体外（注意：注释里不要出现星号紧跟斜杠的组合，
 * 那会提前结束块注释 —— 这行文档本身就把守卫脚本写崩过一次）。
 */
const FORBIDDEN = [{ pattern: /\/src\/renderer\/(?!generated\/)/, label: '内核（src/renderer）' }];

/**
 * 明确允许进静态闭包的上游目录。
 *
 * `src/main/external/**` 是外部歌单导入的 8 个平台解析器，由 `src/bridge/externalApi.ts`
 * 在启动时就 import。已核实它们只用 fetch/axios + 正则，**不碰 window.electron**
 * （唯一的主进程依赖 `electron-log` 已被 alias 换成 console 桩）。
 * 把它们拖到动态加载没有意义：它们与桥本身同属启动路径。
 */
const ALLOWED = [/\/src\/main\/external\//];

const toPosix = (value) => value.split(path.sep).join('/');

const entry = chunks.find((chunk) => chunk.isEntry);
if (!entry) {
  console.error('[boot-order] 构建清单里没有入口 chunk');
  process.exit(1);
}

/** 沿静态 imports 做闭包 */
const visited = new Set();
const violations = [];
const queue = [{ file: entry.file, via: null }];

while (queue.length) {
  const current = queue.shift();
  if (visited.has(current.file)) continue;
  visited.add(current.file);

  const chunk = byFile.get(current.file);
  if (!chunk) continue;

  for (const module of chunk.modules) {
    const relative = toPosix(module);
    if (ALLOWED.some((pattern) => pattern.test(relative))) continue;
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(relative)) {
        violations.push({
          chunk: current.file,
          via: current.via,
          module: relative,
          label,
        });
      }
    }
  }

  for (const next of chunk.imports) queue.push({ file: next, via: current.file });
}

console.log(`[boot-order] 入口 chunk：${entry.file}`);
console.log(`[boot-order] 静态依赖闭包含 ${visited.size} 个 chunk`);

if (violations.length) {
  console.error('\n[boot-order] 内核模块出现在了入口的静态依赖里：\n');
  const seen = new Set();
  for (const item of violations) {
    const key = `${item.chunk}|${item.module}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ✗ ${item.module}`);
    console.error(`      在 chunk ${item.chunk}${item.via ? `（经由 ${item.via}）` : ''}`);
  }
  console.error(
    '\n[boot-order] 这些模块会在 initApiBridge() 之前被求值，抓到的 window.electron 是 undefined。\n' +
      '[boot-order] 修法：在 src/mobile/main.ts 里改用动态 import，\n' +
      '            import 顺序的成因见该文件头部的说明。\n',
  );
  process.exit(1);
}

console.log('[boot-order] 入口不静态依赖内核 ✅');
