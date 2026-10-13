/**
 * Node 内建模块的浏览器替身。
 *
 * server/util 与少数 module 会 require('fs' | 'url' | 'zlib' | 'path')，但这些调用
 * 都在 CLI / 文件相关的分支里，WebView 下不会执行。这里提供可 require 的空壳，
 * 让打包通过；一旦真被执行会打日志，方便定位是不是走了不该走的分支。
 */
const warned = new Set();

const makeStub = (name) =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'default') return makeStub(name);
        const key = `${name}.${String(prop)}`;
        if (!warned.has(key)) {
          warned.add(key);
          // eslint-disable-next-line no-console
          console.warn(`[mobile] Node builtin "${key}" 在 WebView 下不可用，返回空实现`);
        }
        return () => undefined;
      },
      apply() {
        return undefined;
      },
    },
  );

module.exports = makeStub('node-builtin');
module.exports.__esModule = true;
