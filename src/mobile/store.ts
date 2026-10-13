/**
 * Pinia 实例（单例）。
 *
 * 单独成模块有两个原因：
 *
 * 1. **插件注册顺序** —— `sqlitePersistPlugin` 必须在任何 store 被创建**之前**注册。
 *    写在 main.ts 里也行，但路由守卫会在 `router.isReady()` 阶段就创建 user store，
 *    两处谁先谁后取决于调用顺序；放在这里由模块求值保证，不依赖调用者。
 *
 * 2. **路由守卫需要显式实例** —— 守卫在 app 挂载前运行，此时
 *    `getActivePinia()` 可能还是 undefined，`useUserStore()` 会抛
 *    "getActivePinia() was called but there was no active Pinia"。
 *    传实例是最稳的写法（EchoMusic 移动端也是这么处理的）。
 */
import { createPinia } from 'pinia';
import { sqlitePersistPlugin } from '@/stores/sqlitePersist';

export const pinia = createPinia();

pinia.use(sqlitePersistPlugin);
