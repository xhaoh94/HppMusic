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

## 三、启动顺序（最容易踩的坑）

### 机制：静态 import 只允许出现在桥之前

```ts
// src/mobile/main.ts
import '@bridge/polyfills';              // ① server/util 在模块初始化时读 process.env
import { initApiBridge } from '@bridge/apiBridge';
const bridge = initApiBridge({ ... });   // ② 挂 window.electron
initBackButtonHook();

// ③ 剩下的一律动态 import：pinia/store、App.vue、router
const [{ pinia }, { default: App }, { router }] = await Promise.all([...]);
```

原因：内核里有一批模块在**模块初始化时**就抓 `window.electron.*`，
且 ESM 的求值顺序是 **chunk 的静态 import 先于入口模块体**。所以只要内核模块
出现在入口 chunk 的静态依赖里，它们就一定在 `initApiBridge()` 之前被求值 ——
**而且不报错**（日志退化成 console；`window.electron.player` 则完全失效）。

> 曾经试过「把桥的初始化放进一个被第一个 `import` 的模块」来构造顺序保证，
> **实测无效**：Rollup 会把跨 chunk 的 `import` 提到文件顶部，入口 chunk 的
> 模块体排在所有 chunk 之后。顺序保证必须落在**依赖图**上，不能靠 import 语句的书写位置。

### 守卫：`scripts/check-boot-order.mjs`

构建产物里多了 `dist/build-manifest.json`（由 vite 插件输出，记录每个 chunk
实际装了哪些源文件）。守卫从入口 chunk 出发沿**静态 imports** 做闭包，
一旦碰到 `src/renderer/**`（generated 除外）就失败。

这样就能捕获**间接的静态链路**（入口 → A → 内核 也算违规），
而且不依赖分块策略 —— 分块是优化手段会变，依赖图不变量不会。

`src/main/external/**` 在允许名单里：那是外部歌单导入的 8 个平台解析器，
由桥在启动时 import，已核实它们只用 fetch/axios + 正则，不碰 `window.electron`。

## 三之二、图标：CommonJS 默认导出的嵌套包装

`@iconify/icons-tabler/*` 是 CJS 模块（`exports.__esModule = true; exports.default = {...}`）。
打包器对「CJS 默认导出」有两套约定：

- 认 `__esModule`（Babel/Node 语义）→ `import x` 得到 `{ body }` ✅
- 不认（直接取 module.exports）→ `import x` 得到 `{ __esModule, default: { body } }` ❌

**实测本项目产物走的是后者**（而且又包了一层），于是传给 `<Icon :icon>` 的是个
没有 `body` 的对象。Iconify 找不到图标就渲染一个 `viewBox="0 0 16 16"` 的
**空 svg** —— 不报错、不警告，只是「位置上什么都没显示」，看起来很像 CSS 问题。

所以 `src/mobile/icons.ts` 统一用 `import * as` + `unwrapIcon()` 逐层剥 `default`，
两种约定下都成立。同时 `verify-layout.mjs` 多了一条通用断言：
**页面上任何一个 svg 的 innerHTML 为空都算失败**。

## 三之三、时间单位是「秒」

不要凭直觉当成毫秒。三处都是秒：

| 来源 | 验证方式 |
|---|---|
| `Song.duration`（列表时长） | 接口返回 `time_length: 155`（= 2:35），上游 `formatDuration(seconds)` |
| `player.currentTime` / `player.duration` | 上游 `PlayerBar.vue` 的 `formatTime(seconds)` |
| 原生播放器回调 | 实测一段 5 秒 WAV：`duration = 5`，两秒后 `timePos = 1.936` |

原生插件只在媒体控制那条路上乘 1000（`positionMs`，那是 Android 媒体 API 的单位）。
按毫秒算的症状：**所有时长显示 0:00**，且不报错。

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

## 六、KuGou 接口的坑（都实测过，加新功能前先看这里）

上游没有文档，这些结论全部是拿真机请求试出来的。共同特征是
**不报错、只是数据不对**，所以很难靠报错日志发现。

| 坑 | 症状 | 正确做法 |
|---|---|---|
| **歌单 id** | 传数字 specialid → `/playlist/detail` 返回空 `data`、`/playlist/track/all` 报 `20010 get other list file fail` | 传 `global_collection_id`（形如 `collection_3_2132029040_287_0`）；`mapPlaylistMeta` 已把 `global_collection_id / gid / specialid` 依次回退好 |
| **页大小上限不一致** | `/album/songs` 传 `pagesize=100` 直接 **502**（不是空列表）；传 50 正常、60 就挂 | 专辑用 ≤ 50；歌单与歌手作品实测能吃 100 |
| **歌手搜索字段是 PascalCase** | 搜 `author` 返回的是 `AuthorId / AuthorName / Avatar / AudioCount`，用 `singerid` 取会静默拿到 0 | 交给 `mapArtistMeta`（它已处理两套命名）；自己写转换时先 `Object.keys` 看一眼 |
| **播放地址需要 auth** | `/song/url/auth/merge` 必须先用 `getUserVerify()` 拿 `auth`，否则拿不到地址 | 走内核的 `resolveAudioUrl`，不要自己拼参数 |
| **时间单位是秒** | 见「三之三」 | —— |

另外两个从上游继承下来、容易被误判为 bug 的行为：

- `/register/dev` **偶发**返回 `{status:1, data:[]}`（空数组而不是 `{dfid}`）。
  重试即成功，所以启动页做了一次自动重试。
- 风控挑战会让 `utils/request.ts` **挂起直到挑战被解决或取消**。
  界面上必须有验证浮层，否则表现为「按钮一直转、连错误都不报」。

## 七、为什么不用 Tailwind

桌面渲染层用 Tailwind 4，而 Tailwind 的内容扫描根是**项目目录**。移动端目录扫不到
`../src/renderer` 时，`flex-1` / `min-w-0` / `w-screen` 这类类名**一个都不会生成**
（只有恰好也被扫到的 `flex` 会生成），于是布局全面错位且**不报任何错**。
前身项目因此在 `mobile.css` 顶部特意补了 `@import 'tailwindcss'` + `@source`。

本项目 UI 层自研，直接不用 Tailwind：语义化 CSS 变量 + 组件 scoped 样式，
没有"类名没生成"这种静默失败模式。
