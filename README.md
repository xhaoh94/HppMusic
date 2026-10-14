# HppMusic

安卓端第三方音乐客户端。**界面层 100% 自研，业务内核 vendor 自 [EchoMusic](https://github.com/hoowhoami/EchoMusic)。**

技术底座：Capacitor 8 + Vue 3 + Vite 8 + 原生 Media3（ExoPlayer）。

> 本项目是基于公开接口开发的第三方客户端，仅供个人学习与技术研究使用。
> 音乐内容版权归原平台及版权方所有，请支持正版。基于 GPL-3.0 发布。

---

## 为什么是「复用内核 + 重写界面」，而不是从零写原生

前身（`EchoMusicMobile`）把桌面渲染层**整套搬进 WebView**，再用 1309 行构建期字符串改写
补丁 + 1130 行 CSS 覆盖去"掰"成手机形态。这条路的必然结果是：上游改一行就断一个补丁。

但把 API 层也用 Kotlin 重写同样不现实：KuGou 的接口层是 236 个 Node 模块
（签名、非对称加密、设备注册、响应解密），打包后 1.4MB JS。

所以本项目把边界画在**渲染层**上：

| 层 | 归属 | 说明 |
|---|---|---|
| `src/mobile/**` | **自研** | 全部 UI、设计系统、路由、外壳 |
| `src/bridge/**` | 自研（源自前身） | `window.electron.*` 的移动端实现 |
| `android/**` | 自研（源自前身） | Media3 播放器、DSP、前台服务、原生 HTTP |
| `src/renderer/{api,models,utils,stores,services}` | **vendor 自上游** | 业务内核，保持与上游逐字节一致 |
| `src/shared/**`、`src/main/external/**` | **vendor 自上游** | 共享类型与外部歌单解析器 |
| `server/` | git submodule | KuGou API（MakcRe/KuGouMusicApi） |

## 两条铁律

**1. 内核目录只读。** `src/renderer/**`、`src/shared/**`、`src/main/**` 由
`scripts/sync-upstream.mjs` 全量覆盖。手写进内核目录的逻辑下次同步就会消失 —— 这是刻意的。
需要差异化就用 `upstream.json` 的 `exclude`（不 vendor）或 `aliases` / `rewrites`（重定向到 `src/stubs`）。

**2. UI 层禁止引用桌面视图。** `src/mobile/**` 与 `src/bridge/**` 里
`@/...` 只能落在已 vendor 的内核面上，由 `scripts/check-boundary.mjs` 在 CI 阻断。
没有这条机械化约束，补丁思维就会回来。

## 快速开始

```bash
# 前置：Node 22+、pnpm（corepack 自带）、Android SDK、JDK 17+（Android Studio 的 JBR 即可）
git clone <repo> && cd HppMusic
git submodule update --init --recursive    # 拉 KuGou API 子模块
pnpm install
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | API 打包 + Vite 开发服务器（`http://0.0.0.0:5174`，真机可局域网访问） |
| `pnpm build` | 完整构建：API 打包 → 边界检查 → 类型检查 → Vite 构建 → CSS 兼容检查 |
| `pnpm check` | 边界检查 + 类型检查（提交前跑这个） |
| `pnpm test` | 守卫测试（边界、vendor 闭包、路由表、CSS 基线） |
| `pnpm verify:layout [url]` | 无头 Chrome 布局断言（4 档视口，32 项检查） |
| `pnpm android:apk` | 一键出 debug APK（自动探测 JAVA_HOME，含前端构建与同步） |
| `pnpm sync:upstream` | 从上游同步内核（`--check` 只校验不复制） |

### 真机调试

```bash
bash scripts/device-forward.sh          # adb forward 到 WebView 调试端口（pid 每次都会变）
pnpm verify:device "document.title"      # 在真机 WebView 里执行 JS
pnpm verify:device --console 8 "location.hash"   # 顺带收集 8 秒 console
```

## 目录结构

```
src/
├─ mobile/                  全新 UI
│  ├─ design/               设计令牌（tokens.css / theme.ts）
│  ├─ components/           自研基础组件（Sheet / ToastHost / SongRow / …）
│  ├─ shell/                底部三栏 + 主页子页签
│  ├─ features/             按域分包（loading / login / home / explore / search / profile / settings）
│  ├─ adapters/             （P2 起）唯一允许触碰内核 store 的层
│  └─ router/               移动端路由 + 登录守卫
├─ bridge/                  window.electron.* 的移动端实现
├─ stubs/                   未 vendor 内核模块的替代实现
├─ renderer/                ← vendor（只读）
├─ shared/                  ← vendor（只读）
└─ main/external/           ← vendor（只读）
scripts/                    API 打包、上游同步、边界/兼容守卫、验证工具、图标生成
server/                     KuGou API 子模块
android/                    原生工程
docs/                       文档与已知缺口
```

## 关键设计决定

- **不用 Tailwind**。桌面那套工具类依赖构建期扫描 `../src/renderer`，扫不到会**静默退化**
  （旧方案因此在移动端布局全塌，且不报错）。这里全部用语义化 CSS 变量 + 自研组件样式。
- **CSS 基线 Chrome 110**。不用 `color-mix()`（Chrome 111）—— 旧 WebView 上整条声明失效、
  退化成白底白字且不报错。需要透明度就预先算好写 rgba。`scripts/check-css-compat.mjs` 守卫。
- **安全区不用 `env(safe-area-inset-*)`**。Android WebView 不支持它（那是 iOS 特性，写了恒为 0）。
  Capacitor 8 的 SystemBars（默认 `insetsHandling='css'`）会注入 `--safe-area-inset-*`，
  我们在 tokens.css 里统一桥接成 `--safe-*`。
- **外壳用 flex 三段 + 页面内部滚动**，不用 fixed 定位 + padding 补偿。
- **hash 路由**。history 模式下深链接需要原生侧把所有路径回退到 index.html；hash 零配置。

详见 `docs/architecture.md` 与 `docs/known-gaps.md`。
