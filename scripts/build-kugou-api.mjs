/**
 * 生成 KuGou API 的模块表并打包成 ESM，供 WebView 直接 import。
 *
 * 来源与改编说明
 * --------------
 * 本文件改编自 EchoMusic 的 `mobile/scripts/build-kugou-api.mjs`（GPL-3.0-only），
 * 保留其全部构建期补丁与踩坑结论，改动集中在**路径与扫描范围**：
 *
 * | 项 | EchoMusic | 本项目 |
 * |---|---|---|
 * | 渲染层扫描目录 | `../src/renderer`（桌面全量） | `src/renderer`（只有 vendor 的内核子目录） |
 * | server 位置 | 与仓库同级 | 本仓库的 `server/` 子模块（锁定同一 commit） |
 * | 产物路径 | `mobile/src/generated/` | `src/renderer/generated/` |
 *
 * 扫描范围收窄是安全的：实测桌面渲染层共用到 **124 个路由**，而 vendor 的内核
 * （api/models/utils/stores/services）扫描结果**同样是 124 个**，差集为 0 ——
 * 也就是没有任何路由是"只在桌面 views/components 里出现"的。
 * 校验方式：`node scripts/dev/scan-routes.mjs <上游渲染层> src/renderer`。
 * 这样构建不依赖上游工作副本，CI 可复现。
 *
 * 源码**不复制** —— 入口文件直接引 `server/module/*.js`，所以子模块更新会自动跟随，
 * 不存在两份实现漂移的问题。只带渲染层实际会调用的路由：桌面端都到不了的接口
 * 在移动端同样到不了，没必要把 236 个模块全塞进包里。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { applyGradeInfoStandardConfig } from './patches/grade-info-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SERVER = path.join(ROOT, 'server');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const MODULE_DIR = path.join(SERVER, 'module');
const UTIL_DIR = path.join(SERVER, 'util');
const GENERATED = path.join(RENDERER, 'generated');
const ENTRY = path.join(GENERATED, 'kugou-entry.js');
const OUT = path.join(GENERATED, 'kugou-api.js');
const NODE_STUB = path.join(here, 'shims', 'node-stub.cjs');
const URL_STUB = path.join(here, 'shims', 'url-stub.cjs');
const CRYPTO_SHIM = path.join(here, 'shims', 'crypto-shim.cjs');
const ZLIB_SHIM = path.join(here, 'shims', 'zlib-shim.cjs');
const NET_SHIM = path.join(here, 'shims', 'net-shim.cjs');
const FS_UNSUPPORTED_SHIM = path.join(here, 'shims', 'fs-unsupported.cjs');
const PATH_UNSUPPORTED_SHIM = path.join(here, 'shims', 'path-unsupported.cjs');
const FORM_DATA_SHIM = path.join(here, 'shims', 'form-data-shim.cjs');

if (!statSync(MODULE_DIR, { throwIfNoEntry: false })) {
  console.error(`[kugou-api] 找不到 ${MODULE_DIR}`);
  console.error('[kugou-api] 先初始化子模块：git submodule update --init --recursive');
  process.exit(1);
}

// 这些路由来自渲染层接口，但部分调用经过函数/对象动态拼接；显式清单用于防止
// 正则扫描漏掉它们。上传接口只接受内存中的二进制/base64，文件路径交给 native bridge。
const REQUIRED_ROUTES = [
  '/user/grade/info',
  '/user/listen/report',
  '/user/preference',
  '/user/preference/update',
  '/user/visitors',
  '/user/follow/chat',
  '/login/device/kick',
  '/user/update/avatar',
  '/playlist/pic/upload',
  '/user/cloud/upload',
  /**
   * 发表歌曲评论（顶层）。
   *
   * 内核渲染层没有调用它（`api/comment.ts` 只有取数据的一套），
   * 所以路由扫描扫不到 —— 但 server/module 里有完整实现（`comment_music_send.js`），
   * 移动端要支持发评论必须显式加进来。
   * （回复走 `/comment/floor/send`、删除走 `/comment/music/del`，
   *  那两个内核有调用，已经在包里了。）
   */
  '/comment/music/send',
];
const DYNAMIC_ROUTE_FILES = [path.join(RENDERER, 'api', 'listenTogether.ts')];
const UNSUPPORTED_ROUTES = new Map([
  ['/playlist/recommend', 'server/module 中不存在对应实现，移动端明确返回 unsupported/404'],
]);
const UNSUPPORTED_INPUTS = new Map([
  ['/playlist/pic/upload', 'params.file 文件路径需要 native bridge；可直接传 request body 二进制'],
  ['/user/update/avatar', '文件路径输入不支持；请传 imgFile 的 Buffer/base64/dataURL'],
  ['/user/follow/chat', '图片文件路径输入不支持；请传二进制请求体、imgFile 或已上传 url'],
  ['/user/cloud/upload', '文件路径输入不支持；请直接传二进制请求体'],
]);

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

// 1) 渲染层实际调用的路由
const usedRoutes = new Set();
const routeRe = /request\.(?:get|post|put|delete)\(\s*['"](\/[^'"]+)['"]/g;
for (const file of walk(RENDERER)) {
  if (!/\.(ts|vue)$/.test(file)) continue;
  if (file.includes(`${path.sep}generated${path.sep}`)) continue;
  const text = readFileSync(file, 'utf8');
  let match;
  while ((match = routeRe.exec(text))) usedRoutes.add(match[1]);
}

// 一起听 API 使用 routes 对象 + request.post(endpoint, ...) 动态拼接，
// 无法被上面的字面量正则发现。桌面端会扫描全部 server/module，移动端则必须
// 显式加入，否则生成包里没有对应模块，/listen/together/* 请求会直接返回 404，
// 页面最终只会显示"没有找到匹配的房间"。
[
  '/listen/together/study',
  '/listen/together/music',
  '/listen/together/room',
  '/listen/together/chat',
  '/listen/together/discovery',
].forEach((route) => usedRoutes.add(route));

// 动态路由文件单独扫描：不要依赖 request.post(endpoint) 的字面量匹配。
for (const file of DYNAMIC_ROUTE_FILES) {
  if (!readFileSync(file, 'utf8')) continue;
  const text = readFileSync(file, 'utf8');
  let match;
  const dynamicRouteRe = /['"](\/[^'"]+)['"]/g;
  while ((match = dynamicRouteRe.exec(text))) usedRoutes.add(match[1]);
}
REQUIRED_ROUTES.forEach((route) => usedRoutes.add(route));

// 2) 路由 → 模块（文件名 _ 换回 /）
const routeOf = (file) => `/${file.replace(/\.js$/, '').replace(/_/g, '/')}`;
const BUILTIN_RE = /require\(['"](?:node:)?([a-zA-Z0-9_/-]+)['"]\)/g;
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs',
  'http', 'https', 'net', 'os', 'path', 'perf_hooks', 'stream', 'string_decoder', 'tls',
  'url', 'util', 'tty', 'vm', 'worker_threads', 'zlib',
]);
const BUILTIN_SHIMS = new Set(['crypto', 'zlib', 'net', 'fs', 'path', 'url', 'os']);

const included = [];
const skipped = [];
for (const file of readdirSync(MODULE_DIR).filter((f) => f.endsWith('.js'))) {
  const route = routeOf(file);
  if (!usedRoutes.has(route)) continue;
  const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
  const dependencies = new Set();
  let dependency;
  while ((dependency = BUILTIN_RE.exec(source))) dependencies.add(dependency[1].replace(/^node:/, ''));
  const unsupported = [...dependencies].filter((name) => NODE_BUILTINS.has(name) && !BUILTIN_SHIMS.has(name));
  if (unsupported.length) {
    skipped.push({ route, reason: `Node 模块 ${unsupported.join(', ')}` });
    continue;
  }
  included.push({ file, route });
}

const moduleRoutes = new Map();
for (const file of readdirSync(MODULE_DIR).filter((f) => f.endsWith('.js'))) {
  const route = routeOf(file);
  if (moduleRoutes.has(route)) throw new Error(`[kugou-api] 路由冲突: ${route}`);
  moduleRoutes.set(route, file);
}
const missing = [...usedRoutes].filter(
  (route) => !moduleRoutes.has(route) && !UNSUPPORTED_ROUTES.has(route),
);
const unsupported = skipped.filter(({ route }) => !UNSUPPORTED_ROUTES.has(route));
if (missing.length || unsupported.length) {
  const details = [
    missing.length ? `缺少模块: ${missing.join(', ')}` : '',
    unsupported.length
      ? `依赖无法转换: ${unsupported.map(({ route, reason }) => `${route}（${reason}）`).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  throw new Error(`[kugou-api] 构建校验失败，不能生成缺路由/空 shim 包: ${details}`);
}

// 3) 生成入口（每个模块一行 import，路径指回 server/ 源文件）
//
// 这里只做一件事：把 Capacitor 的 HTTP 插件实例挂到全局。
// request.js 的注入适配器（见下方 esbuild onLoad）与打包入口**不是同一个模块实例**，
// 在入口改 axios.defaults 对它无效，只能靠 globalThis 传递。
const BRIDGE_GLOBALS = [
  "import { CapacitorHttp } from '@capacitor/core';",
  'globalThis.__ECHO_CAP_HTTP__ = CapacitorHttp;',
].join('\n');

mkdirSync(GENERATED, { recursive: true });
const imports = included
  .map((m, i) => `import m${i} from ${JSON.stringify(path.join(MODULE_DIR, m.file))};`)
  .join('\n');
const map = included.map((m, i) => `  ${JSON.stringify(m.route)}: m${i},`).join('\n');
const unsupportedRouteEntries = JSON.stringify([...UNSUPPORTED_ROUTES], null, 2);
const unsupportedInputEntries = JSON.stringify([...UNSUPPORTED_INPUTS], null, 2);

// util 也从同一个包出，桥接层就不用再单独引一份 server/util
const utilImports = [
  `import { cryptoMd5 } from ${JSON.stringify(path.join(UTIL_DIR, 'crypto.js'))};`,
  `import { getGuid, calculateMid, generateWebGLHash } from ${JSON.stringify(path.join(UTIL_DIR, 'util.js'))};`,
  `import { createRequest } from ${JSON.stringify(path.join(UTIL_DIR, 'request.js'))};`,
  `import { applyCliOverrides } from ${JSON.stringify(path.join(UTIL_DIR, 'runtime.js'))};`,
].join('\n');

writeFileSync(
  ENTRY,
  `${imports}\n\n${utilImports}\n\n${BRIDGE_GLOBALS}\n\nexport const modules = {\n${map}\n};\n\n// 供移动端/测试展示明确的能力边界；这些不是伪造的成功响应。\nexport const unsupportedRoutes = new Map(${unsupportedRouteEntries});\nexport const unsupportedInputs = new Map(${unsupportedInputEntries});\n\nexport const util = {\n  cryptoMd5,\n  getGuid,\n  calculateMid,\n  generateWebGLHash,\n  createRequest,\n  applyCliOverrides,\n};\n`,
  'utf8',
);

// 4) 二进制响应补丁（**不改上游源文件**，只在打包时内存改写）
//
// 桌面端 Node 里 axios 的 `responseType:'arraybuffer'` 给的是 Buffer（有 `.toString('base64')`），
// 浏览器里给的是 ArrayBuffer（没有）。request.js 的 `const body = response.data;` 之后
// 会走 `body.toString()`，二进制时得到 "[object ArrayBuffer]" → 模块拿去解密直接抛
// `RangeError: Invalid typed array length: -NNN`，表现成接口 502（如 /register/dev 设备注册）。
// 归一化只针对二进制，JSON 那条路不受影响。
const REQUEST_JS = path.join(UTIL_DIR, 'request.js');
const BODY_NEEDLE = 'const body = response.data;';
const BODY_HELPER = `const __echoNormalizeBody = (value) => {
  if (typeof Buffer === 'undefined' || value === null || value === undefined) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
};
`;

// Capacitor 自带的 XHR 补丁不支持 responseType：它调原生插件时只传
// {url, method, data, dataType, headers}，二进制响应被原生按文本 UTF-8 解码 → 密文全坏。
// 原生插件本身支持（readData → ARRAY_BUFFER 走 readStreamAsBase64），所以这里给
// arraybuffer 的请求单独挂一个 adapter，直接走原生 bridge 拿 base64。
//
// 注意必须注入在 request.js **内部**：它的 `require('axios')` 与打包入口 import 的
// axios 不是同一个模块实例，在入口改 `axios.defaults.adapter` 对它无效（实测无任何反应）。
const ADAPTER_NEEDLE = "const axios = require('axios');";
const ADAPTER_HELPER = `${"const axios = require('axios');"}

const __echoBase64ToBytes = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const __echoBase64ToBuffer = (base64) => {
  const bytes = __echoBase64ToBytes(base64);
  return typeof Buffer === 'undefined' ? bytes.buffer : Buffer.from(bytes);
};

const __echoBytesToText = (bytes) => {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('utf8');
  return new TextDecoder('utf-8').decode(bytes);
};

/** 原生返回「头名 -> 值数组」，收敛回 axios 形态；set-cookie 保持数组。 */
const __echoFlattenHeaders = (headers, cookies) => {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const value = headers[key];
    out[String(key).toLowerCase()] =
      Array.isArray(value) && value.length === 1 ? value[0] : value;
  }
  if (Array.isArray(cookies) && cookies.length) out['set-cookie'] = cookies;
  return out;
};

const __echoPlainHeaders = (headers) => {
  const source = headers && typeof headers.toJSON === 'function' ? headers.toJSON() : headers || {};
  const out = {};
  for (const key of Object.keys(source)) {
    const lower = key.toLowerCase();
    const value = source[key];
    if (value === undefined || value === null) continue;
    // 交给原生层自己算，写死了可能和实际字节数不一致
    if (lower === 'content-length' || lower === 'host') continue;
    out[key] = String(value);
  }
  return out;
};

const __echoBinaryAdapter = async (config) => {
  const payload = {
    url: axios.getUri(config),
    method: String(config.method || 'get').toUpperCase(),
    headers: __echoPlainHeaders(config.headers),
    data: typeof config.data === 'string' ? config.data : undefined,
    // 只要 responseType —— dataType 是**请求体**类型，设成 arraybuffer 会让原生
    // 把请求体也当 base64 解析，上游收到坏数据（实测：解密结果不是合法 JSON）
    responseType: 'arraybuffer',
  };
  const bridge = globalThis.Capacitor;
  const response =
    bridge && typeof bridge.nativePromise === 'function'
      ? await bridge.nativePromise('CapacitorHttp', 'request', payload)
      : await globalThis.__ECHO_CAP_HTTP__?.request?.(payload);
  if (!response) throw new Error('CapacitorHttp 不可用，无法请求二进制接口');
  return {
    data:
      typeof response.data === 'string' ? __echoBase64ToBuffer(response.data) : response.data,
    status: response.status,
    statusText: '',
    headers: response.headers || {},
    config,
    request: {},
  };
};
`;
const ADAPTER_OPTION_NEEDLE = "responseType: options.responseType,  // 响应类型（如 'arraybuffer'）";
const ADAPTER_OPTION_PATCH = `${"responseType: options.responseType,  // 响应类型（如 'arraybuffer'）"}\n      adapter: options.responseType === 'arraybuffer' ? __echoBinaryAdapter : undefined,`;

const normalizeUploadInputs = {
  name: 'echo-normalize-upload-inputs',
  setup(build) {
    // ⚠️ esbuild 在 Windows 上给的 args.path 是反斜杠路径，必须用 [\\/] 而不能写 module\/，
    // 否则 onLoad 永远不触发 —— 补丁会静默失效（实测两个补丁都因此从未生效过）。
    build.onLoad(
      { filter: /module[\\/](playlist_pic_upload|user_follow_chat|user_cloud_upload)\.js$/ },
      (args) => {
        // ⚠️ 上游 module 是 CRLF 行尾，多行 needle 会因此匹配不上（补丁静默失效）。
        // 统一成 LF 再匹配；输出 LF 的 JS 对 esbuild 没有影响。
        const source = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
        const helper = `const __echoNormalizeMobileBinary = (value) => {
  if (typeof Buffer === 'undefined' || value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
};
`;
        let patched = source;
        if (args.path.endsWith('playlist_pic_upload.js')) {
          const old = `    if (!Buffer.isBuffer(params?.data) && (!filePath || !fs.existsSync(filePath))) {`;
          const oldImage = `    const image = Buffer.isBuffer(params?.data) ? params.data : fs.readFileSync(filePath);`;
          if (!source.includes(old) || !source.includes(oldImage)) {
            throw new Error('[kugou-api] playlist_pic_upload.js 文件输入补丁目标已变化');
          }
          patched = source
            .replace(
              old,
              `    const imageData = __echoNormalizeMobileBinary(params?.data);\n    if (!imageData && (!filePath || !fs.existsSync(filePath))) {`,
            )
            .replace(oldImage, `    const image = imageData || fs.readFileSync(filePath);`);
        } else if (args.path.endsWith('user_follow_chat.js')) {
          const old = `      const image = Buffer.isBuffer(params?.data)\n        ? params.data\n        : typeof params?.imgFile === 'string'\n          ? normalizeBase64(params.imgFile)\n          : null;`;
          if (!source.includes(old)) {
            throw new Error('[kugou-api] user_follow_chat.js 文件输入补丁目标已变化');
          }
          patched = source.replace(
            old,
            `      const image = __echoNormalizeMobileBinary(params?.data)\n        || (typeof params?.imgFile === 'string'\n          ? normalizeBase64(params.imgFile)\n          : null);`,
          );
        } else if (args.path.endsWith('user_cloud_upload.js')) {
          const old = `      const fileData = params?.data || Buffer.alloc(0);`;
          if (!source.includes(old)) {
            throw new Error('[kugou-api] user_cloud_upload.js 文件输入补丁目标已变化');
          }
          patched = source.replace(old, `      const fileData = __echoNormalizeMobileBinary(params?.data) || Buffer.alloc(0);`);
        }
        return { contents: helper + patched, loader: 'js' };
      },
    );
  },
};

/**
 * `/user/grade/info` 改用标准版配置（仅移动端打包时注入）。
 *
 * 具体替换规则与原因见 scripts/patches/grade-info-config.mjs —— 抽成共享模块是为了
 * 让测试能直接验证「补丁作用在上游原文件上的结果」（子模块指向上游仓库，改动无法随 fork 分发）。
 */
const gradeInfoStandardConfig = {
  name: 'echo-grade-info-standard-config',
  setup(build) {
    // 同上：Windows 下 args.path 是反斜杠，过滤器必须兼容两种分隔符。
    build.onLoad({ filter: /module[\\/]user_grade_info\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      const { contents, patched } = applyGradeInfoStandardConfig(source);
      if (!patched) console.log('[kugou-api] user_grade_info.js 已是标准版配置，跳过补丁');
      return { contents, loader: 'js' };
    });
  },
};

const AXIOX_NATIVE_SHIM = path.join(here, 'shims', 'axios-native.cjs');

/**
 * QQ 扫码登录模块的 axios 调用改走 CapacitorHttp（仅移动端）。
 *
 * 这两个模块直接用原生 axios 而不是 useAxios，在 WebView 里会退回 XHR：
 * 浏览器禁止设置 Cookie/Referer/User-Agent，实测 ptqrshow 因 Cookie 被丢弃返回 403，
 * 二维码一直显示"加载失败"。改走原生请求后同样的请求返回 200。
 * 只重写这两个文件里的 `require('axios')`，其它模块继续用打包内的 axios。
 */
const routeQqLoginThroughNativeHttp = {
  name: 'echo-qq-login-native-http',
  setup(build) {
    // 同上：Windows 下 args.path 用反斜杠，过滤器必须兼容两种分隔符。
    build.onLoad({ filter: /module[\\/]login_qq_qr_(create|check)\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      const needle = "const axios = require('axios');";
      if (!source.includes(needle)) {
        // 宁可构建失败，也不要静默出一个二维码加载不出来的包。
        throw new Error(
          `[kugou-api] ${path.basename(args.path)} 里找不到 "${needle}"，QQ 登录原生请求补丁需要更新`,
        );
      }
      return {
        contents: source.replace(needle, `const axios = require(${JSON.stringify(AXIOX_NATIVE_SHIM)});`),
        loader: 'js',
      };
    });
  },
};

const normalizeBinaryResponse = {
  name: 'echo-normalize-binary-response',
  setup(build) {
    build.onLoad({ filter: /request\.js$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(REQUEST_JS)) return null;
      const source = readFileSync(args.path, 'utf8');
      for (const needle of [BODY_NEEDLE, ADAPTER_NEEDLE, ADAPTER_OPTION_NEEDLE]) {
        if (!source.includes(needle)) {
          // 宁可构建失败，也不要静默出一个坏包
          throw new Error(
            `[kugou-api] request.js 里找不到 "${
              needle.length > 60 ? needle.slice(0, 60) + '…' : needle
            }"，响应补丁需要更新`,
          );
        }
      }
      const patched =
        BODY_HELPER +
        source
          .replace(BODY_NEEDLE, 'const body = __echoNormalizeBody(response.data);')
          .replace(ADAPTER_NEEDLE, ADAPTER_HELPER)
          .replace(ADAPTER_OPTION_NEEDLE, ADAPTER_OPTION_PATCH);
      return { contents: patched, loader: 'js' };
    });
  },
};

// 5) 打包成单文件 ESM
await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  define: { global: 'globalThis' },
  plugins: [
    normalizeUploadInputs,
    normalizeBinaryResponse,
    routeQqLoginThroughNativeHttp,
    gradeInfoStandardConfig,
  ],
  alias: {
    crypto: CRYPTO_SHIM,
    zlib: ZLIB_SHIM,
    net: NET_SHIM,
    fs: FS_UNSUPPORTED_SHIM,
    path: PATH_UNSUPPORTED_SHIM,
    'form-data': FORM_DATA_SHIM,
    os: NODE_STUB,
    url: URL_STUB,
  },
  logLevel: 'warning',
});

const bytes = readFileSync(OUT).length;
console.log(`[kugou-api] 渲染层用到 ${usedRoutes.size} 个路由`);
console.log(`[kugou-api] 已打包 ${included.length} 个模块 → ${path.relative(ROOT, OUT)}`);
console.log(`[kugou-api] 产物 ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (UNSUPPORTED_ROUTES.size) {
  console.log('[kugou-api] unsupported routes:');
  [...UNSUPPORTED_ROUTES].forEach(([route, reason]) => console.log(`            ${route}: ${reason}`));
}
if (UNSUPPORTED_INPUTS.size) {
  console.log('[kugou-api] unsupported inputs（路由仍可用，但以下输入必须交给 native bridge）:');
  [...UNSUPPORTED_INPUTS].forEach(([route, reason]) => console.log(`            ${route}: ${reason}`));
}
