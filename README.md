# HppMusic

酷狗概念版安卓端第三方音乐客户端。

技术底座：Capacitor 8 + Vue 3 + Vite + 原生 Media3（ExoPlayer）。

> 本项目基于公开接口开发，仅供个人学习与技术研究使用。
> 音乐内容版权归原平台及版权方所有，请支持正版。

---

## 功能

| 模块 | 说明 |
|---|---|
| 登录 | 手机号 / 短信 / 账号密码 / 二维码 / 第三方，共 5 种 |
| 发现 | 每日推荐、推荐歌单、编辑精选 |
| 随便听 | 一次给一批歌，不满意换一批；快播完时自动增量续播 |
| 一起听 | 创建/加入房间、房主控进度、成员列表 |
| 探索 | 两级歌单分类（6 个父类 + 子标签）|
| 搜索 | 综合、单曲、歌单、专辑、歌手 |
| 播放页 | 歌词（含逐字）、写真、封面模糊背景、弹幕、音质切换、评论 |
| 排行榜 | 热门榜单 + 更多榜单 |
| 听歌识曲 | 录制片段识别 |
| MV | 全屏播放 |
| 评论 | 楼层、回复、点赞列表、发表 |
| 我的 | 收藏、歌单、播放历史、个人资料编辑（头像/昵称/签名/性别/生日/地区）|
| 设置 | 主题、播放行为、音质、歌词、数据 |

## 架构

界面与内核之间画了一条硬边界：

| 层 | 归属 | 说明 |
|---|---|---|
| `src/mobile/**` | HppMusic | 全部 UI、设计系统、路由、外壳 |
| `src/bridge/**` | HppMusic | 把内核依赖的 `window.electron.*` 接到移动端实现上 |
| `android/**` | HppMusic | Media3 播放器、DSP、前台服务、原生 HTTP |
| `src/renderer/{api,models,utils,stores,services}` | 只读内核 | 业务逻辑与接口层 |
| `src/shared/**`、`src/main/external/**` | 只读内核 | 共享类型、外部歌单解析器 |
| `server/` | git submodule | KuGou API（[MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)）|

### 两条由脚本强制的约束

**1. 内核目录只读。** `src/renderer/**`、`src/shared/**`、`src/main/**` 会被
`scripts/sync-upstream.mjs` 全量覆盖。手写进内核目录的逻辑下次同步就会消失 —— 这是刻意的。
需要差异化时用 `upstream.json` 的 `exclude`（不引入）、`aliases` / `rewrites`（重定向到 `src/stubs`）。

**2. UI 层禁止引用内核里的桌面视图。** `src/mobile/**` 与 `src/bridge/**` 中的 `@/...`
只能落在已纳入的内核面上，由 `scripts/check-boundary.mjs` 在提交前阻断。

这两条不是洁癖：没有机械化约束，补丁就会以"先改一下让它跑起来"的方式慢慢长回内核里。

## 快速开始

```bash
# 前置：Node 22+、pnpm（corepack 自带）、Android SDK、JDK 17+（Android Studio 的 JBR 即可）
git clone https://github.com/xhaoh94/HppMusic.git && cd HppMusic
git submodule update --init --recursive    # 拉 KuGou API 子模块
pnpm install
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | API 打包 + Vite 开发服务器（`http://0.0.0.0:5174`，真机可局域网访问） |
| `pnpm build` | 完整构建：API 打包 → 边界检查 → 类型检查 → Vite 构建 → CSS 兼容检查 |
| `pnpm check` | 边界检查 + 类型检查（提交前跑这个） |
| `pnpm test` | 守卫测试（边界、内核闭包、路由表、CSS 基线） |
| `pnpm verify:layout [url]` | 无头 Chrome 布局断言（4 档视口，32 项检查） |
| `pnpm android:apk` | 一键出 debug APK（自动探测 JAVA_HOME，含前端构建与同步） |

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
│  ├─ components/           基础组件（Sheet / ToastHost / SongRow / …）
│  ├─ shell/                底部栏 + 主页子页签
│  ├─ features/             按域分包（home / player / search / profile / settings / …）
│  ├─ adapters/             唯一允许触碰内核 store 的层
│  ├─ composables/          跨页复用的状态（滚动记忆、播放偏好、…）
│  └─ router/               路由 + 登录守卫
├─ bridge/                  window.electron.* 的移动端实现
├─ stubs/                   未引入的内核模块的替代实现
├─ renderer/                ← 只读内核
├─ shared/                  ← 只读内核
└─ main/external/           ← 只读内核
scripts/
├─ dev/                     图标生成等开发工具
server/                     KuGou API 子模块
android/                    原生工程
docs/                       架构说明与已知缺口
```

## 关键设计决定

- **不用 Tailwind。** 它的工具类依赖构建期扫描源码目录，一旦扫描范围不含内核目录就会
  **静默退化**（页面布局全塌但不报错）。这里全部用语义化 CSS 变量 + 组件样式。
- **CSS 基线是 Chrome 110。** 不用 `color-mix()`（Chrome 111 才有）—— 旧 WebView 上
  整条声明失效、退化成白底白字且不报错。需要透明度就预先算好写 `rgba`。
  `scripts/check-css-compat.mjs` 守卫这条。
- **安全区不用 `env(safe-area-inset-*)`。** 那是 iOS 特性，Android WebView 里写了恒为 0。
  Capacitor 8 的 SystemBars 会注入 `--safe-area-inset-*`，在 `tokens.css` 里统一桥接成 `--safe-*`。
- **外壳用 flex 三段 + 页面内部滚动**，不用 fixed 定位 + padding 补偿。
- **路由用 hash 模式。** history 模式下深链接需要原生侧把所有路径回退到 `index.html`；hash 零配置。
- **图标是脚本生成的。** 5 个密度 × 3 个变体（普通/圆形/自适应前景）全靠
  `scripts/dev/gen-app-icon.mjs` 从一份 108×108 坐标推导，改色只需改两个常量。

更多细节见 `docs/architecture.md` 与 `docs/known-gaps.md`。

## 许可

见 [LICENSE](./LICENSE)。
