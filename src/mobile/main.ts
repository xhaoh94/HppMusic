/**
 * 应用入口。
 *
 * ⚠️ 顺序是这个文件最重要的东西，两条都不能反：
 *
 * 1. `@bridge/polyfills` 必须**第一个** import。
 *    `server/util/index.js` 在模块初始化时就读 `process.env.platform` 决定
 *    appid/clientver，所以 Buffer / process / global 必须在任何 server 代码
 *    被求值之前挂到 globalThis 上。
 *
 * 2. `initApiBridge()` 必须**先于**任何会读 `window.electron` 的模块求值。
 *    内核里有一批模块在**模块初始化时**就抓 `window.electron.player` 之类
 *    （`utils/player.ts` 最典型），而 ESM 的静态 import 会在本文件任何语句
 *    执行前把整棵依赖树求值完 —— 写成静态 import，它们只会抓到 undefined，
 *    桥永远失效（而且不报错，表现为"播放键按下去没反应"）。
 *    所以 App / router 一律走动态 import，放在桥挂好之后。
 */
import '@bridge/polyfills';

import { createApp } from 'vue';
import { Icon } from '@iconify/vue';

import '@mobile/design/tokens.css';

import { initApiBridge } from '@bridge/apiBridge';
import { initBackButtonHook } from '@bridge/backButton';
import { pinia } from '@mobile/store';

const bridge = initApiBridge({ version: __APP_VERSION__ });

// 返回键钩子尽早装：原生 onBackPressed 随时可能 eval 它（首帧启动页也会）。
// 具体消费方（浮层 / 播放页）由各页面在挂载时注册。
initBackButtonHook();

const [{ default: App }, { router }] = await Promise.all([
  import('@mobile/App.vue'),
  import('@mobile/router'),
]);

const app = createApp(App);

app.use(pinia);
app.use(router);
app.component('Icon', Icon);

app.config.errorHandler = (error, _instance, info) => {
  // 兜底：Vue 组件内的异常不该让整个界面白屏，至少留下可查的痕迹
  console.error('[mobile] vue error:', info, error);
};

void router.isReady().then(() => {
  app.mount('#app');
  console.info(`[mobile] mounted, bridge modules = ${bridge.moduleCount}`);
});
