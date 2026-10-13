/* 当前 API 包不需要 Node path；保留显式失败，避免路径相关逻辑静默产生坏值。 */
const unsupported = (operation) => {
  throw new Error(`[mobile] path.${operation} 不支持：请在原生 bridge 处理文件路径`);
};

module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return module.exports;
    return (..._args) => unsupported(String(prop));
  },
});
