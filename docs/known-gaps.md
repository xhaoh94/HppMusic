# 已知缺口（Known Gaps）

按「影响使用」排序。每条都写明**现象**、**当前行为**、**补齐时机**。

---

## 1. 安全验证只支持短信码，交互式验证码（腾讯/极验/滑块）未实现

- **现象**：账号触发酷狗风控时，会出现「本次操作需要『腾讯验证码』，当前版本尚未支持该验证方式」。
- **当前行为**：给出明确提示并提供**取消**。取消会释放被挂起的请求并返回可读错误，
  不会让登录按钮一直转。已支持：短信验证码（输入+提交）、登录确认、绑定手机号/实名/风控的告知。
- **为什么没有一起做**：桌面实现 764 行（第三方 SDK 脚本加载 + iframe 定位 + 残留 DOM 清理），
  且严重依赖桌面窗口布局；照搬到触屏上是负收益。
- **补齐时机**：P1。做法是在 `src/mobile/components/VerificationSheet.vue` 里按 provider 分支，
  加载对应 SDK 并在 App 内嵌 WebView/iframe 中承载；内核侧状态机（`@/utils/kugouVerification`）已就绪，不需要改。

## 2. 播放链路未接线（P0 范围决定）

- **现象**：点歌只弹「播放功能将在下一步接入」。
- **当前行为**：每日推荐列表能真实拉取并渲染（说明设备注册、加密请求、响应解密、映射全链路已通），
  但不播放。
- **补齐时机**：P2。原生的 `EchoNativePlayerPlugin` / `EchoPlaybackService`（Media3 + 通知栏 + DSP）
  已随工程编译进 APK，只差渲染层接线。

## 3. 主界面布局未做自动化验证

- **现象**：`pnpm verify:layout` 只覆盖**未登录可达**的页面（启动页、登录页）。
- **原因**：主界面需要真实登录态；无头 Chrome 里设备注册与鉴权都会失败，无法造出可信的登录状态。
- **当前替代**：真机验证（`bash scripts/device-forward.sh` + `pnpm verify:device "..."`）。
- **补齐时机**：P1。给 `verify-layout.mjs` 加 `--fake-login`，通过 CDP
  `Page.addScriptToEvaluateOnNewDocument` 预置 localStorage 里的持久化用户态
  （键名规则见 `src/bridge/storage.ts` 的 `KV_PREFIX` 与 `@shared/storePersistence`）。

## 4. 未实现的功能入口一律不展示

设计原则：**不铺一排点了没反应的图标**。当前未接入的入口只有两种状态 ——
要么不存在，要么明确标注「即将开放」。因此现在「我的」页只有收藏/历史两条带标注的占位，
排行榜、听歌识曲等磁贴标注「即将支持」。

## 5. 1.4MB API bundle 首屏一次性加载

- **现象**：冷启动需要解析 ~684KB（minified）的 KuGou API 产物。
- **当前行为**：可接受（实测构建产物分块后首屏 ~1MB minified / ~300KB gzip），暂未优化。
- **补齐时机**：P5。按路由分组拆包 + 动态 import。

## 6. 应用图标仍是 Capacitor 默认图标

- **补齐时机**：P5（打包与发布阶段）。

---

## 附：已处理的上游行为

### `/register/dev` 偶发返回空 `data`

- **现象**：首次请求偶发返回 `{status:1, error_code:0, data:[]}`（`data` 是空数组而非 `{dfid}`）。
  内核的 `ensureDevice` 把它当失败且不重试，用户看到「设备注册失败」错误页 —— 其实再等一下就好。
- **已处理**：`LoadingPage.vue` 在 UI 层补了一次自动重试（间隔 800ms），不改内核。
  实测重试即成功（一次冷启动实测中复现并验证）。
