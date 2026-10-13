/**
 * url 模块的浏览器替身。
 *
 * 不能一律返回空实现：浏览器里 URL / URLSearchParams 是**全局对象**，
 * 代码 `const { URL } = require('url')` 之后如果拿到空函数，构建出来的 URL
 * 会静默变成坏值。这里把全局转发过去，其余属性才降级并告警。
 */
const known = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
};

module.exports = new Proxy(known, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol') return undefined;
    if (prop === 'default') return module.exports;
    // eslint-disable-next-line no-console
    console.warn(`[mobile] url.${String(prop)} 在 WebView 下未实现`);
    return () => undefined;
  },
});
