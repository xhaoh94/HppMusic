/* zlib 的浏览器替身：server 仅使用 deflateSync，底层复用已有 pako。 */
const pako = require('pako');
const BufferCtor = () => {
  if (!globalThis.Buffer) throw new Error('[mobile] zlib shim 需要 Buffer polyfill');
  return globalThis.Buffer;
};

module.exports = {
  deflateSync(value) {
    const input = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value;
    return BufferCtor().from(pako.deflate(input));
  },
};
module.exports.__esModule = true;
