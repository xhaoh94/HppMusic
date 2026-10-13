#!/usr/bin/env node
/**
 * 架构边界守卫（CI 阻断）。
 *
 * ## 为什么需要这条规则
 *
 * 本项目的前身把**桌面渲染层整套搬进 WebView**，再用 1300 行构建期字符串改写补丁
 * 去"掰"成手机形态。那条路的必然结局是：上游改一行就断一个补丁，一年后没人敢同步。
 *
 * 「界面全部重新设计」要能长期成立，前提是**禁止 UI 层触碰桌面视图**。
 * 没有这条机械化的约束，只要允许一次 `import Sidebar from '@/layouts/Sidebar.vue'`，
 * 补丁思维就会回来，然后逐条累积成第二个 vite.config.ts。
 *
 * ## 规则
 *
 * `src/mobile/**` 与 `src/bridge/**` 里的 `@/...` 导入，必须落在**已 vendor 的内核面**里：
 *
 *   api/ models/ utils/ stores/ services/ types.ts
 *   theme/{colors,model,registry}.ts
 *   plugins/{audioSource,lyrics,coverFallback}.ts
 *   components/music/songContextMenuExtensions.ts   ← 唯一允许的 components 例外（纯注册表，44 行）
 *
 * 之外一律视为违规：桌面外壳（views/layouts/composables/components）、
 * 桌面专属子系统（desktopLyric/miniPlayer/nowPlaying/plugins/runtime/tasks）、
 * 以及桌面入口（App.vue / router / style.css / motion.css）。
 *
 * 顺带做导入解析：**任何解析不到的导入都算失败** —— 包括相对路径。
 * 这类问题在构建期才暴露，跑一次静态检查能省掉一轮「装到手机上才发现白屏」。
 *
 * 用法：node scripts/check-boundary.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 被守卫的目录（UI 层 + 胶水层） */
const GUARDED = ['src/mobile', 'src/bridge', 'src/stubs'];

/**
 * 允许从内核层导入的路径前缀。
 *
 * 写成「精确到文件或目录」的白名单，而不是"允许 @/ 开头"——
 * 后者等于没规则：桌面渲染层所有东西都是 @/ 开头。
 */
const ALLOWED_RENDERER = [
  'api',
  'models',
  'utils',
  'stores',
  'services',
  /**
   * ⚠️ 这里是**按 specifier 前缀**匹配的，而导入写的是 `@/types`（不带扩展名），
   * 所以不能写成 `types.ts`—— 写错了会永远匹配不上，把合法导入误报成越界。
   * 本项目就因此吃了一报（写设置页时第一次用到 `@/types` 才暴露）。
   */
  'types',
  // 由 scripts/build-kugou-api.mjs 生成的 KuGou API 打包产物（gitignore，不在内核白名单的概念里，
  // 但桥接层必须能引它）
  'generated',
  'theme/colors',
  'theme/model',
  'theme/registry',
  'plugins/audioSource',
  'plugins/lyrics',
  'plugins/coverFallback',
  'components/music/songContextMenuExtensions',
];

const ALLOWED_PREFIXES = ['@shared/', '@mobile/', '@bridge/', '@stubs/'];

/**
 * 内部别名的根。
 *
 * `@capacitor/core` 这种也是 `@` 开头，但它是第三方包，不是内部别名 ——
 * 不能一律按 `@` 当成内部路径去解析（那样会把所有 scoped 包误报成越界）。
 */
const INTERNAL_SCOPES = ['@/', '@shared/', '@mobile/', '@bridge/', '@stubs/'];

const CANDIDATE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.vue', '.json', '.css'];

const toPosix = (value) => value.split(path.sep).join('/');

const resolveModuleFile = (base) => {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of CANDIDATE_EXT) if (existsSync(base + ext)) return base + ext;
  for (const ext of CANDIDATE_EXT) {
    const indexFile = path.join(base, `index${ext}`);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
};

const walk = (dir) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|vue|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const IMPORT_RE = /(?:^|[^\w.])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * 先去掉注释再扫导入。
 *
 * 否则「文档注释里的示例导入语句」会被当成真导入（本项目就踩过：
 * src/stubs/desktop-layout.ts 的注释里写了三条上游原始 import 作为说明）。
 * 同时注释掉的代码也不应该计入校验。
 */
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const violations = [];
let scanned = 0;
let checkedImports = 0;

for (const guarded of GUARDED) {
  for (const file of walk(path.join(ROOT, guarded))) {
    const rel = toPosix(path.relative(ROOT, file));
    const code = stripComments(readFileSync(file, 'utf8'));
    scanned += 1;

    const specifiers = new Set();
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(code))) specifiers.add(match[1]);
    }

    for (const specifier of specifiers) {
      checkedImports += 1;

      // 相对导入：能解析就行
      if (specifier.startsWith('.')) {
        if (!resolveModuleFile(path.resolve(path.dirname(file), specifier))) {
          violations.push({ rel, specifier, why: '相对导入解析不到文件' });
        }
        continue;
      }
      // 第三方包（含 @capacitor/core 这种 scoped 包）不归边界规则管
      if (!INTERNAL_SCOPES.some((scope) => specifier.startsWith(scope))) continue;

      if (specifier.startsWith('@/')) {
        const inner = specifier.slice(2);
        const allowed = ALLOWED_RENDERER.some(
          (entry) => inner === entry || inner.startsWith(`${entry}/`),
        );
        if (!allowed) {
          violations.push({
            rel,
            specifier,
            why: '不在内核白名单内（桌面渲染层/桌面专属子系统不参与移动端 UI）',
          });
          continue;
        }
        if (!resolveModuleFile(path.join(ROOT, 'src/renderer', inner))) {
          violations.push({ rel, specifier, why: '内核白名单内，但文件不存在（vendor 缺失？）' });
        }
        continue;
      }

      const allowed = ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix));
      if (!allowed) {
        violations.push({ rel, specifier, why: '未知的内部别名前缀' });
        continue;
      }
      const base = specifier.startsWith('@shared/')
        ? path.join(ROOT, 'src/shared', specifier.slice(8))
        : specifier.startsWith('@mobile/')
          ? path.join(ROOT, 'src/mobile', specifier.slice(8))
          : specifier.startsWith('@bridge/')
            ? path.join(ROOT, 'src/bridge', specifier.slice(8))
            : path.join(ROOT, 'src/stubs', specifier.slice(7));
      if (!resolveModuleFile(base)) {
        violations.push({ rel, specifier, why: '别名解析不到文件' });
      }
    }
  }
}

console.log(`[boundary] 扫描 ${scanned} 个文件、${checkedImports} 处导入`);

if (violations.length) {
  console.error(`\n[boundary] 发现 ${violations.length} 处越界：\n`);
  for (const { rel, specifier, why } of violations) {
    console.error(`  ✗ ${rel}`);
    console.error(`      ${specifier}  —— ${why}`);
  }
  console.error(
    '\n[boundary] 修改方式：\n' +
      '  · UI 需要的数据/能力，应该在 src/mobile/adapters 或 src/bridge 里自建，\n' +
      '    由它去调用内核 store/api —— 而不是直接引桌面组件。\n' +
      '  · 如果确实需要某个内核文件，请加进 upstream.json 的 include 并重跑 sync。\n',
  );
  process.exit(1);
}

console.log('[boundary] 边界校验通过 ✅');
