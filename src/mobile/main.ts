/**
 * 应用入口。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⚠️ 这个文件的 import 结构是**加载顺序的正确性保证**，不是风格问题。
 *
 * 内核里有一批模块在**模块初始化时**就抓 `window.electron.*`：
 *   · `@/utils/logger`   → `window.electron.log`（抓不到就退化成 console，
 *                          不报错，只是日志丢了 [renderer] 通道）
 *   · `@/utils/player`   → `window.electron.player`（抓不到就永远静默失败）
 *
 * 而 ESM 的求值顺序是：**chunk 的静态 import 先于本文件任何语句**。
 * 也就是说，只要"内核模块"出现在入口 chunk 的静态依赖里，它们就一定
 * 在 `initApiBridge()` 之前被求值 —— 无论 `initApiBridge()` 写在多前面。
 *
 * （曾经试过"把桥的初始化放进一个被第一个 import 的模块"来保证顺序，
 *   实测无效：Rollup 会把跨 chunk 的 import 提到文件顶部，入口 chunk 的
 *   模块体排在所有 chunk 之后。构造性的顺序保证必须落在**依赖图**上。）
 *
 * 所以这里的规则是：
 *   ① 入口的静态 import 只允许出现「不依赖内核」的东西 —— polyfills、vue、
 *      iconify、apiBridge、backButton、CSS；
 *   ② 凡是会碰到内核的（pinia/store、App.vue、router）一律**动态 import**，
 *      放在 `initApiBridge()` 之后；
 *   ③ `scripts/check-boot-order.mjs` 在构建后检查产物，确认入口 chunk 没有
 *      静态引用内核 chunk —— 这条纪律由 CI 兜底，不靠人记。
 * ═══════════════════════════════════════════════════════════════════
 */
import '@bridge/polyfills';

import { createApp } from 'vue';
import { Icon } from '@iconify/vue';

import '@mobile/design/tokens.css';

import { initApiBridge } from '@bridge/apiBridge';
import { initBackButtonHook } from '@bridge/backButton';

/** 桥必须在下面任何一个 await import 之前挂好 */
const bridge = initApiBridge({ version: __APP_VERSION__ });

// 返回键钩子尽早装：原生 onBackPressed 随时可能 eval 它（首帧启动页也会）。
// 具体消费方（浮层 / 播放页）由各组件在挂载时注册。
initBackButtonHook();

const [{ pinia }, { default: App }, { router }] = await Promise.all([
  import('@mobile/store'),
  import('@mobile/App.vue'),
  import('@mobile/router'),
]);

const app = createApp(App);

app.use(pinia);
app.use(router);
app.component('Icon', Icon);

app.config.errorHandler = (error, _instance, info) => {
  // 兜底：组件内的异常不该让整个界面白屏，至少留下可查的痕迹
  console.error('[mobile] vue error:', info, error);
};

void router.isReady().then(() => {
  app.mount('#app');
  console.info(`[mobile] mounted, bridge modules = ${bridge.moduleCount}`);
});
