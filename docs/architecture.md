# 架构说明

## 一、分层

```
┌──────────────────────────────────────────────────────────┐
│ src/mobile/**          全新 UI（本仓库唯一"手写业务"的地方）│
│   设计令牌 / 组件 / 外壳 / 页面 / 适配层 / 路由            │
├──────────────────────────────────────────────────────────┤
│ src/bridge/**          window.electron.* 的移动端实现      │
│   apiBridge（Kugou 模块调用）/ nativePlayer / storage …    │
├──────────────────────────────────────────────────────────┤
│ src/renderer/{api,models,utils,stores,services}  ← vendor  │
│ src/shared/**  src/main/external/**              ← vendor  │
│   业务内核：请求、映射、状态、歌词、播放控制……              │
├──────────────────────────────────────────────────────────┤
│ src/renderer/generated/kugou-api.js   ← 构建产物（gitignore）│
│   server/ 里被内核用到的 128 个模块，esbuild 打成单文件 ESM  │
├──────────────────────────────────────────────────────────┤
│ android/**             Media3 播放器 + DSP + 前台服务 + HTTP │
└──────────────────────────────────────────────────────────┘
```

依赖方向只能向下。**反向依赖由 `scripts/check-boundary.mjs` 阻断。**

## 二、内核 vendor 机制

### 为什么是 vendor 而不是 submodule / npm 包

上游 EchoMusic 是一个桌面应用仓库，内核（stores/api/utils）与桌面 UI 混在同一个 `src/renderer` 里。
没有独立的包边界可依赖，所以只能按**白名单复制**。

### `upstream.json` 是唯一的差异声明处

内核文件必须与上游**逐字节一致**，任何差异只能出现在三处：

| 字段 | 用途 | 例子 |
|---|---|---|
| `exclude` | 不 vendor（依赖桌面专属模块） | `stores/pluginUpdates.ts`（插件系统） |
| `aliases` | 按模块路径重定向到 `src/stubs` | `@/plugins/runtime/theme` → 桩 |
| `rewrites` | 定点文本替换（**相对路径导入**用） | `setting.ts` 的三行桌面布局导入 |

`aliases` 走 vite/tsconfig 别名，内核文件一个字节都不动；
`rewrites` 是兜底，用于「同一个相对路径字符串在不同目录含义不同、alias 无法表达」的情况。
两者在锚点消失时都会**直接报错终止**，而不是静默放过 —— 上游改了这几行必须有人重新确认。

### 同步时的自检

`scripts/sync-upstream.mjs` 复制完成后会扫描所有内核文件的导入并逐个解析：

- `@/...`、`@shared/...`、`@stubs/...`、**相对路径**（相对路径曾经漏检，导致
  `stores/setting.ts` 的三个桌面布局导入一路漏到类型检查阶段才发现）
- 第三方包是否在 `package.json` 里声明（被 `aliases` 重定向的包豁免，如 `electron-log`）

任何一项解析不到就终止，并提示该加进 `include` / `exclude` 还是 `aliases`。

## 三、桥接层的加载顺序（最容易踩的坑）

```ts
// src/mobile/main.ts —— 顺序不能反
import '@bridge/polyfills';              // ① 必须最先：server/util 在模块初始化时读 process.env
import { initApiBridge } from '@bridge/apiBridge';
const bridge = initApiBridge({ ... });   // ② 挂 window.electron
initBackButtonHook();
const App = await import('@mobile/App.vue');   // ③ 动态 import
const { router } = await import('@mobile/router');
```

原因：内核里有一批模块在**模块初始化时**就抓 `window.electron.player`
（`utils/player.ts` 最典型）。ESM 的静态 import 会在本文件任何语句执行前把整棵依赖树求值完 ——
写成静态 import，它们只会抓到 `undefined`，桥永远失效。**而且不报错**，
表现为"播放键按下去没反应"，极难排查。

## 四、Android 平台结论（都是实测得出，不要凭直觉改）

### 1. `env(safe-area-inset-*)` 在 Android WebView 上恒为 0

那是 iOS Safari 的特性。Capacitor 8 内置 `SystemBars`（`insetsHandling` 默认 `'css'`）
会通过 `evaluateJavascript` 注入 `--safe-area-inset-*` 内联变量。

两种 WebView 版本行为不同：新版本（insets 穿透）注入真实值，必须样式层自己留白；
旧版本 Capacitor 给 decorView 加 padding，注入 0px。所以统一桥接成 `--safe-*`，两种都正确。

### 2. CSS 基线是 Chrome 110

`color-mix()` 需要 Chrome 111。旧 WebView 上整条声明失效，computed 值退化成 `#ffffff`
—— 表现是「白底白字」，不报错不崩溃。本项目从设计上避开（预计算 rgba），
并留 `scripts/check-css-compat.mjs` 守卫产物。

### 3. 二进制响应必须走原生 HTTP

浏览器给的 `responseType:'arraybuffer'` 是 `ArrayBuffer`（没有 `.toString('base64')`），
而 `server/util/request.js` 期望 Node 的 Buffer。不做归一化，模块拿去解密会抛
`RangeError: Invalid typed array length: -NNN`，表现成接口 502（设备注册就是这么挂的）。

Capacitor 自带的 XHR 补丁还不支持 `responseType`，所以二进制请求单独挂了一个 adapter
直接走原生 bridge 拿 base64。细节见 `scripts/build-kugou-api.mjs` 的注释。

### 4. 必须开 CapacitorHttp

内核的 `utils/request.ts` 走 axios，在 WebView 里会退化成 XHR，直连 `gateway.kugou.com`
被 CORS 拦掉（对方不返回 `Access-Control-Allow-Origin`）。开启后 XHR/fetch 由 native-bridge
重写走原生 HTTP，顺带绕开浏览器禁止设置 `User-Agent` 的限制。

### 5. 数据库/`localStorage` 语义

移动端 `window.electron.storage` 由 `src/bridge/storage.ts` 用 `localStorage` 实现
（键前缀 `echo.mobile.kv.`）。pinia 持久化插件 `sqlitePersistPlugin` 因此落在 localStorage 上，
容器约 5MB，足够设置与队列快照。

## 五、为什么不用 Tailwind

桌面渲染层用 Tailwind 4，而 Tailwind 的内容扫描根是**项目目录**。移动端目录扫不到
`../src/renderer` 时，`flex-1` / `min-w-0` / `w-screen` 这类类名**一个都不会生成**
（只有恰好也被扫到的 `flex` 会生成），于是布局全面错位且**不报任何错**。
前身项目因此在 `mobile.css` 顶部特意补了 `@import 'tailwindcss'` + `@source`。

本项目 UI 层自研，直接不用 Tailwind：语义化 CSS 变量 + 组件 scoped 样式，
没有"类名没生成"这种静默失败模式。
