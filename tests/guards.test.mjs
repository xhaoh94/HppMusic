/**
 * 端到端守卫测试。
 *
 * 这几个测试不测"函数返回值"，测的是**仓库的一致性**：
 * 每次出现"上游改了东西"或"有人越过了边界"时，这里是唯一能在装机前拦住的关卡。
 * 前身项目的失败模式正是"每一条单独看都没错，合起来没人守"，所以这些检查
 * 必须能一条命令跑完（`pnpm test`），而不是散落在某几个脚本里靠人记得执行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runNode = (script) =>
  execFileSync('node', [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('架构边界', () => {
  it('UI 层与桥接层不引用桌面渲染层的任何视图', () => {
    expect(() => runNode('check-boundary.mjs')).not.toThrow();
  });
});

describe('上游内核 vendor 闭包', () => {
  it('内核的每一个导入都能解析（含相对路径）', () => {
    expect(() => runNode('sync-upstream.mjs')).not.toThrow();
  });

  it('upstream.json 声明了 vendor 来源 commit', () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'upstream.json'), 'utf8'));
    expect(config.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(config.include.length).toBeGreaterThan(0);
  });
});

describe('KuGou API 打包产物', () => {
  const entryPath = path.join(ROOT, 'src', 'renderer', 'generated', 'kugou-entry.js');

  it('产物存在（缺失说明没跑 api:build）', () => {
    expect(existsSync(entryPath)).toBe(true);
  });

  /**
   * 核心断言：内核里调用的每个路由，生成的模块表里都得有。
   *
   * 少了任何一个的症状是运行时 404，而且只在走到那条业务的用户路径上才暴露
   * （比如"评论楼层跳转"），非常难排查。这里在构建期就比对干净。
   */
  it('内核调用的每个路由都在模块表里', () => {
    const walk = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(ts|vue)$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const routeRe = /request\.(?:get|post|put|delete)\(\s*['"](\/[^'"]+)['"]/g;
    const used = new Set();
    for (const file of walk(path.join(ROOT, 'src', 'renderer'))) {
      if (file.includes(`${path.sep}generated${path.sep}`)) continue;
      const code = readFileSync(file, 'utf8');
      routeRe.lastIndex = 0;
      let match;
      while ((match = routeRe.exec(code))) used.add(match[1]);
    }

    const entry = readFileSync(entryPath, 'utf8');
    const exported = new Set(
      [...entry.matchAll(/^\s*"(\/[^"]+)":\s*m\d+,$/gm)].map((match) => match[1]),
    );
    const unsupported = new Set(
      [...entry.matchAll(/\[\s*"(\/[^"]+)",\s*"[\s\S]*?"\s*\]/g)].map((match) => match[1]),
    );

    const missing = [...used].filter(
      (route) => !exported.has(route) && !unsupported.has(route),
    );
    expect(missing, `以下路由没有对应模块：${missing.join(', ')}`).toEqual([]);
    expect(used.size).toBeGreaterThan(50);
  });

  it('产物里没有残留本机绝对路径（否则换机器构建会带上开发者路径）', () => {
    const bundle = readFileSync(
      path.join(ROOT, 'src', 'renderer', 'generated', 'kugou-api.js'),
      'utf8',
    );
    expect(bundle).not.toMatch(/[A-Za-z]:\\\\Project/);
  });
});

describe('CSS 兼容基线', () => {
  it('构建产物不含超过 Chrome 110 的特性', () => {
    const dist = path.join(ROOT, 'dist');
    if (!statSync(dist, { throwIfNoEntry: false })) {
      // 没构建过就跳过：这条是构建后检查，由 `pnpm build` 里的步骤保证
      return;
    }
    expect(() => runNode('check-css-compat.mjs')).not.toThrow();
  });
});
