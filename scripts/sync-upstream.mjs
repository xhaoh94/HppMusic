#!/usr/bin/env node
/**
 * 上游内核同步。
 *
 * 本项目把 EchoMusic 的**业务内核**（stores / api / models / utils / services / shared）
 * vendor 进来，UI 层完全自研。这个脚本负责"vendor"这一动作，保证：
 *
 * 1. 内核文件的每一个字节都与上游一致 —— 差异只允许出现在两处：
 *    · `upstream.json` 的 `exclude`（不 vendor 的文件）
 *    · `upstream.json` 的 `aliases`（用 vite/tsconfig 别名重定向到 src/stubs）
 *    任何手写进内核目录的逻辑，下次同步都会消失。这是刻意的。
 *
 * 2. 同步后立刻做**闭包自检**：扫描所有被 vendor 的文件里出现的 `@/xxx` 与 `@shared/xxx`
 *    导入，逐个确认能落到「已 vendor 的文件 / 已声明的别名 / allowUiImports」三者之一。
 *    漏掉任何一个都会在运行时炸在浏览器里（Vite 报 "Failed to resolve import"），
 *    在这里提前拦住，比装到手机上再查便宜得多。
 *
 * 用法：
 *   node scripts/sync-upstream.mjs                 # 同步 + 自检
 *   node scripts/sync-upstream.mjs --check         # 只自检，不复制（CI 用）
 *   node scripts/sync-upstream.mjs --root <路径>    # 覆盖上游路径
 *   ECHOMUSIC_UPSTREAM=<路径> node scripts/sync-upstream.mjs
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(ROOT, 'upstream.json');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const rootArgIndex = argv.indexOf('--root');
const CLI_ROOT = rootArgIndex >= 0 ? argv[rootArgIndex + 1] : null;

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const upstream = path.resolve(
  CLI_ROOT ?? process.env.ECHOMUSIC_UPSTREAM ?? config.localPath ?? '',
);

if (!upstream || !existsSync(upstream)) {
  console.error(`[sync] 找不到上游仓库：${upstream || '(未配置)'}`);
  console.error('[sync] 用 --root <路径> 或 ECHOMUSIC_UPSTREAM=<路径> 指定。');
  process.exit(1);
}

const INCLUDES = config.include ?? [];
const EXCLUDES = new Set(config.exclude ?? []);
const ALIASES = config.aliases ?? {};
const ALLOW_UI = config.allowUiImports ?? {};

// ── 1. 记录上游版本 ──────────────────────────────────────────────
const git = (args) => {
  try {
    return execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const commit = git(['rev-parse', 'HEAD']) || '(unknown)';
// 只看内核相关路径是否被改过；mobile/ 一直在迭代，不该因此判定上游"脏"。
const dirtyPaths = (config.include ?? [])
  .map((entry) => entry.replace(/\/.*$/, '') && entry)
  .concat(['src/shared', 'src/renderer'])
  .filter((value, index, list) => list.indexOf(value) === index);
const porcelain = git(['status', '--porcelain', '--', ...dirtyPaths]);
const dirty = porcelain.length > 0;

// ── 2. 复制 ────────────────────────────────────────────────────
const toPosix = (value) => value.split(path.sep).join('/');

const copyEntry = (relative) => {
  const from = path.join(upstream, relative);
  const to = path.join(ROOT, relative);
  if (!existsSync(from)) {
    throw new Error(`[sync] include 条目在上游不存在：${relative}`);
  }
  if (EXCLUDES.has(relative)) return { files: 0, skipped: true };

  const isDir = statSync(from).isDirectory();
  if (!isDir) {
    if (EXCLUDES.has(relative)) return { files: 0, skipped: true };
    rmSync(to, { force: true });
    cpSync(from, to);
    return { files: 1, skipped: false };
  }

  let files = 0;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const rel = toPosix(path.relative(upstream, source));
      if (EXCLUDES.has(rel)) return false;
      return true;
    },
  });
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files += 1;
    }
  };
  walk(to);
  return { files, skipped: false };
};

if (!CHECK_ONLY) {
  let total = 0;
  for (const entry of INCLUDES) {
    const { files } = copyEntry(entry);
    total += files;
    console.log(`[sync] ${entry} → ${files} 个文件`);
  }
  console.log(`[sync] 共复制 ${total} 个文件（排除 ${EXCLUDES.size} 个）`);
}

// ── 2.5 定点改写（rewrites） ────────────────────────────────────
//
// 只用于「相对路径导入」这类 alias 无法表达的情况：同一个字符串在不同目录含义不同，
// Vite 的 alias 是按字面前缀匹配的，按模块路径重定向会误伤。
// 每次同步都重新套用（源文件是刚复制过来的干净副本），锚点找不到就报错终止 ——
// 上游改了这几行，必须有人重新确认一遍，不能静默放过。
const REWRITES = config.rewrites ?? [];

if (!CHECK_ONLY) {
  for (const rule of REWRITES) {
    const target = path.join(ROOT, rule.file);
    if (!existsSync(target)) {
      console.error(`[sync] rewrite 目标文件不存在：${rule.file}`);
      process.exit(1);
    }
    let code = readFileSync(target, 'utf8');
    for (const { from, to } of rule.replacements ?? []) {
      if (!code.includes(from)) {
        console.error(`[sync] rewrite 锚点丢失：${rule.file}\n  找不到：${from}`);
        console.error(`  原因记录：${rule.why ?? '(未注明)'}`);
        process.exit(1);
      }
      code = code.split(from).join(to);
    }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, code);
    console.log(`[sync] rewrite ${rule.file} → ${rule.replacements?.length ?? 0} 处`);
  }
}

// ── 3. 闭包自检 ────────────────────────────────────────────────
const CANDIDATE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.vue', '.json', '.css'];

const resolveModuleFile = (base) => {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of CANDIDATE_EXT) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of CANDIDATE_EXT) {
    const indexFile = path.join(base, `index${ext}`);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
};

/** 长别名优先（与 vite alias 的前缀匹配语义一致）。 */
const aliasKeys = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

const resolveSpecifier = (specifier) => {
  for (const key of aliasKeys) {
    if (specifier === key || specifier.startsWith(`${key}/`)) {
      return { kind: 'alias', target: ALIASES[key] };
    }
  }
  // allowUiImports 的 value 是「为什么允许」的说明，不是目标路径 —— 目标就是它自己。
  if (specifier in ALLOW_UI) {
    const file = resolveModuleFile(
      path.join(ROOT, 'src/renderer', specifier.slice(2)),
    );
    return file
      ? { kind: 'allowed-ui', target: file }
      : { kind: 'allowed-ui', target: specifier, missing: true };
  }
  if (specifier.startsWith('@stubs/')) {
    const file = resolveModuleFile(path.join(ROOT, 'src/stubs', specifier.slice('@stubs/'.length)));
    return file ? { kind: 'file', target: file } : null;
  }
  if (specifier.startsWith('@shared/')) {
    const file = resolveModuleFile(path.join(ROOT, 'src/shared', specifier.slice('@shared/'.length)));
    return file ? { kind: 'file', target: file } : null;
  }
  if (specifier.startsWith('@/')) {
    const file = resolveModuleFile(path.join(ROOT, 'src/renderer', specifier.slice(2)));
    return file ? { kind: 'file', target: file } : null;
  }
  return { kind: 'external', target: specifier };
};

const IMPORT_RE = /(?:^|[^\w.])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const collectVendoredFiles = () => {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|vue|js|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  // 只检查真正会被打包的内核面；stubs / bridge / mobile 由 check-boundary.mjs 负责。
  walk(path.join(ROOT, 'src/shared'));
  walk(path.join(ROOT, 'src/renderer'));
  // src/main/external 是内核的一部分（外部歌单导入的 8 个平台解析器），同样要自检。
  walk(path.join(ROOT, 'src/main'));
  return out;
};

const problems = [];
const externals = new Set();
const aliasHits = new Map();
let scanned = 0;

for (const file of collectVendoredFiles()) {
  const rel = toPosix(path.relative(ROOT, file));
  if (rel.startsWith('src/renderer/generated/')) continue;
  const code = readFileSync(file, 'utf8');
  scanned += 1;
  const specifiers = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code))) specifiers.add(match[1]);
  }
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.') && !specifier.startsWith('@')) continue;
    // 相对导入同样要解析：内核里有一部分依赖是 `../plugins/xxx`、`../../shared/xxx` 这种写法，
    // 只查 `@/` 会漏掉它们（本项目就漏过一次：setting.ts 的 3 个桌面布局导入）。
    if (specifier.startsWith('.')) {
      const resolvedFile = resolveModuleFile(path.resolve(path.dirname(file), specifier));
      if (!resolvedFile) problems.push(`${rel} → 无法解析相对导入 ${specifier}`);
      continue;
    }
    const resolved = resolveSpecifier(specifier);
    if (!resolved) {
      problems.push(`${rel} → 无法解析 ${specifier}`);
      continue;
    }
    if (resolved.kind === 'alias' || resolved.kind === 'allowed-ui') {
      if (resolved.missing) {
        problems.push(`${rel} → allowUiImports 声明的文件不存在：${specifier}`);
        continue;
      }
      const key = `${specifier} ⇒ ${toPosix(path.relative(ROOT, resolved.target))}`;
      aliasHits.set(key, (aliasHits.get(key) ?? 0) + 1);
    }
  }
}

// 第三方依赖同样要能装得上，否则打包阶段才炸
const PKG_RE = /(?:^|[^\w.])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([a-z@][^'"]*)['"]/g;
const declared = new Set([
  ...Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies ?? {}),
  ...Object.keys(
    JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies ?? {},
  ),
]);
for (const file of collectVendoredFiles()) {
  const rel = toPosix(path.relative(ROOT, file));
  if (rel.startsWith('src/renderer/generated/')) continue;
  const code = readFileSync(file, 'utf8');
  PKG_RE.lastIndex = 0;
  let match;
  while ((match = PKG_RE.exec(code))) {
    const specifier = match[1];
    // 内部别名不是第三方依赖，不参与 package.json 校验
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('@/') ||
      specifier.startsWith('@shared/') ||
      specifier.startsWith('@stubs/')
    ) {
      continue;
    }
    const pkgName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    externals.add(pkgName);
    // 被 aliases 重定向到 stubs 的包（如 electron-log）不需要真实安装。
    if (aliasKeys.includes(pkgName)) continue;
    if (!declared.has(pkgName)) {
      problems.push(`${rel} → 第三方依赖未在 package.json 声明：${pkgName}`);
    }
  }
}

console.log(`[sync] 自检扫描 ${scanned} 个内核文件`);
console.log(`[sync] 别名命中 ${aliasHits.size} 处：`);
for (const [key, count] of aliasHits) console.log(`         ${key}  ×${count}`);
console.log(`[sync] 内核引用第三方：${[...externals].sort().join(', ') || '(无)'}`);

if (problems.length) {
  console.error(`\n[sync] 发现 ${problems.length} 个未解析的导入：`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    '\n[sync] 处理方式三选一：加进 upstream.json 的 include（要 vendor）、' +
      'exclude（不 vendor 且没人引用）、或 aliases（重定向到 src/stubs）。',
  );
  process.exit(1);
}

// ── 4. 回写版本记录 ────────────────────────────────────────────
if (!CHECK_ONLY) {
  const next = {
    ...config,
    commit,
    localPath: toPosix(upstream),
    dirty,
    syncedAt: new Date().toISOString(),
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[sync] 上游 commit=${commit.slice(0, 12)}${dirty ? '（内核路径有未提交改动！）' : ''}`);
}

console.log('[sync] 闭包自检通过 ✅');
