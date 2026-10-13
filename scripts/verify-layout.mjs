/**
 * 布局回归检查（无头 Chrome + CDP）。
 *
 * ## 为什么不直接在真机上跑
 *
 * 布局问题（横向溢出、外壳与内容重叠、安全区重复留白）与 WebView 版本无关，
 * 用同内核的桌面 Chrome 验更快更稳 —— 真机只留到最后确认一轮。
 * 真机工具是 scripts/device-eval.mjs（走 WebView CDP）。
 *
 * ## 为什么是断言而不是打印
 *
 * 打印一堆数字"看起来没问题"是不可回归的（没人会认真读）。这里每条都是
 * 明确断言，失败就 exit 1，可以直接挂进 CI / pre-commit。
 *
 * ## 覆盖的路由
 *
 * 启动页与登录页是**未登录就能到达**的页面，所以这里默认验它们。
 * 主界面（外壳）需要登录态，改用真机 + device-eval 验（见 docs/known-gaps.md）。
 *
 * 用法：
 *   node scripts/verify-layout.mjs                          # 默认 http://127.0.0.1:4173/#/login
 *   node scripts/verify-layout.mjs http://127.0.0.1:4173/#/
 *   node scripts/verify-layout.mjs --shot out.png
 *   CHROME_PATH="..." node scripts/verify-layout.mjs
 *
 * 前置：先跑 `npx vite preview --port 4173`（或任何静态服务指向 dist/）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9333;
const CHROME =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shot');
const shotPath = shotIndex >= 0 ? args[shotIndex + 1] : null;
const url =
  args.find((arg, index) => !arg.startsWith('--') && index !== shotIndex + 1) ??
  'http://127.0.0.1:4173/#/login';

/** 覆盖主流手机宽度：360(小屏) / 412(Pixel 类) / 450(参考产品的设计宽度) */
const VIEWPORTS = [
  { width: 360, height: 800, label: '360x800 竖屏' },
  { width: 412, height: 915, label: '412x915 竖屏' },
  { width: 450, height: 900, label: '450x900 竖屏' },
  { width: 900, height: 450, label: '900x450 横屏' },
];

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--window-size=450,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* 进程可能已退出 */
  }
};
process.on('exit', cleanup);

async function connect() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('连不上 Chrome 的调试端口');
}

const socket = new WebSocket(await connect());
let seq = 0;
const pending = new Map();

const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});

await send('Page.enable');
await send('Runtime.enable');

const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text ?? '页面执行异常');
  }
  return response.result?.result?.value;
};

/**
 * 页面内探针。一次注入拿回所有判断所需的数据，断言在 Node 侧做 ——
 * 这样失败信息能带上具体数字，而不是页面里抛一句 assert 失败。
 */
const PROBE = `(() => {
  const de = document.documentElement;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
  };
  const cssVar = (name) => getComputedStyle(de).getPropertyValue(name).trim();

  // 找出横向溢出的元素（只报最靠右的 5 个，避免刷屏）
  // 空 svg = 图标没渲染出来。
  //
  // 这是个很容易静默失效的地方：图标数据拿不到时，Iconify 会渲染一个
  // viewBox="0 0 16 16" 的空 svg —— 不报错、不警告，只是“位置上什么都没有”，
  // 看起来很像 CSS 问题。本项目实测过一次（@iconify/icons-tabler 的 CJS
  // 默认导出被多包了一层），所以把它当成一条通用断言。
  // （注意：这里是模板字符串内部，写注释不要用反引号）
  const emptySvgs = [...document.body.querySelectorAll('svg')]
    .filter((svg) => svg.innerHTML.trim().length === 0)
    .map((svg) => String(svg.parentElement?.className || svg.parentElement?.tagName || '').slice(0, 40));

  const bleeders = [];
  const limit = de.clientWidth + 2;
  for (const el of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.position === 'fixed' && style.overflowX === 'auto') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > limit) {
      bleeders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        right: Math.round(r.right),
      });
    }
  }
  bleeders.sort((a, b) => b.right - a.right);

  return JSON.stringify({
    viewport: [innerWidth, innerHeight],
    docOverflowX: de.scrollWidth - de.clientWidth,
    appHeight: rect(document.getElementById('app'))?.h ?? null,
    shell: rect(document.querySelector('.shell')),
    content: rect(document.querySelector('.shell-content')),
    subTabBar: rect(document.querySelector('.sub-tab-bar')),
    bottomBar: rect(document.querySelector('.bottom-bar')),
    safeTop: cssVar('--safe-top'),
    safeBottom: cssVar('--safe-bottom'),
    shellTopInset: cssVar('--shell-top-inset') || null,
    visibleText: (document.body.innerText || '').trim().slice(0, 80),
    bleeders: bleeders.slice(0, 5),
    totalBleeders: bleeders.length,
    totalSvgs: document.body.querySelectorAll('svg').length,
    emptySvgs,
  });
})()`;

let failures = 0;
let checks = 0;

const assert = (label, condition, detail = '') => {
  checks += 1;
  if (condition) {
    console.log(`    ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`    ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
};

/** 安全区变量必须是可解析的 px 值（Android WebView 不支持 env()，靠 Capacitor 注入） */
const isPx = (value) => /^-?\d+(\.\d+)?px$/.test(String(value || '').trim());

console.log(`[verify-layout] 目标：${url}\n`);

for (const viewport of VIEWPORTS) {
  console.log(`  ${viewport.label}`);

  await send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await send('Page.navigate', { url });
  // 等待 Vue 挂载 + 路由守卫跑完（守卫会 await pinia 水合）。
  // 轮询而不是固定 sleep：CI 上固定值要么不够要么白等。
  let probe = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(400);
    probe = JSON.parse(await evaluate(PROBE));
    if (probe.appHeight && probe.visibleText) break;
  }

  if (!probe?.appHeight) {
    assert('页面已渲染', false, '8 秒内 #app 仍没有高度（白屏？）');
    continue;
  }

  assert('页面有可见内容', probe.visibleText.length > 0, `innerText="${probe.visibleText}"`);
  assert('无横向滚动', probe.docOverflowX <= 1, `overflowX=${probe.docOverflowX}px`);
  assert(
    '无元素横向溢出',
    probe.totalBleeders === 0,
    `共 ${probe.totalBleeders} 个，最右：${probe.bleeders
      .map((item) => `${item.tag}.${item.cls} right=${item.right}`)
      .join(' / ')}`,
  );
  assert(
    '#app 铺满视口高度',
    Math.abs(probe.appHeight - probe.viewport[1]) <= 1,
    `app=${probe.appHeight} viewport=${probe.viewport[1]}`,
  );
  assert('--safe-top 是 px 值', isPx(probe.safeTop), `值=${probe.safeTop}`);
  assert('--safe-bottom 是 px 值', isPx(probe.safeBottom), `值=${probe.safeBottom}`);
  assert(
    '所有 svg 图标都有内容',
    probe.emptySvgs.length === 0,
    `${probe.emptySvgs.length}/${probe.totalSvgs} 个空图标：${probe.emptySvgs.join(' / ')}`,
  );

  // 外壳相关断言只在真的渲染出外壳时执行（登录页没有外壳）
  if (probe.shell) {
    assert(
      '外壳高度等于视口高度',
      Math.abs(probe.shell.h - probe.viewport[1]) <= 1,
      `shell=${probe.shell.h} viewport=${probe.viewport[1]}`,
    );
    if (probe.bottomBar) {
      assert(
        '底部栏贴住视口底边',
        Math.abs(probe.bottomBar.bottom - probe.viewport[1]) <= 1,
        `bottomBar.bottom=${probe.bottomBar.bottom}`,
      );
      assert(
        '内容区与底部栏不重叠',
        probe.content && probe.content.bottom <= probe.bottomBar.y + 1,
        `content.bottom=${probe.content?.bottom} bottomBar.y=${probe.bottomBar.y}`,
      );
    }
    if (probe.subTabBar) {
      assert(
        '子页签栏从视口顶部开始',
        probe.subTabBar.y === 0,
        `subTabBar.y=${probe.subTabBar.y}（safe-top=${probe.safeTop}）`,
      );
    }
  } else {
    console.log('    · 该路由没有外壳（全屏页），跳过外壳断言');
  }
}

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`\n[verify-layout] 截图已存：${shotPath}`);
  }
}

socket.close();
cleanup();

console.log(`\n[verify-layout] ${checks - failures}/${checks} 项通过`);
if (failures > 0) {
  console.error(`[verify-layout] ${failures} 项失败`);
  process.exit(1);
}
console.log('[verify-layout] 全部通过 ✅');
