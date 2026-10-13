/**
 * 系统返回键的 WebView 侧钩子。
 *
 * 原生 MainActivity.onBackPressed 会 eval `window.__echoMobileBack()`：
 * 返回 true 表示这次返回已被浮层消费（原生不再动路由、不退后台）；
 * 返回 false 或钩子缺失时，原生按 WebView 历史路由后退，没有历史则退到后台。
 *
 * 处理器按注册的倒序询问（后注册的先问）—— 与「上层浮层优先」一致。
 */

type BackHandler = () => boolean;

const handlers = new Set<BackHandler>();

/** 注册返回键处理器；返回退订函数。处理器返回 true = 已消费。 */
export const pushBackHandler = (handler: BackHandler): (() => void) => {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
};

export const initBackButtonHook = (): void => {
  (window as unknown as { __echoMobileBack?: () => boolean }).__echoMobileBack = () => {
    // 倒序副本：遍历期间增删注册不影响本次决策
    for (const handler of Array.from(handlers).reverse()) {
      if (handler()) return true;
    }
    return false;
  };
};
