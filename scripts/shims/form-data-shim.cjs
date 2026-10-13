/*
 * form-data 的浏览器适配：使用原生 FormData，保留 server 模块需要的 getHeaders。
 * 返回原生实例让 axios 继续走浏览器 multipart 适配器，由浏览器生成 boundary。
 */
function FormDataShim() {
  if (typeof globalThis.FormData !== 'function') {
    throw new Error('[mobile] FormData 不可用：头像上传需要 WebView FormData 或原生 bridge');
  }
  const form = new globalThis.FormData();
  const append = form.append.bind(form);
  form.append = (name, value, options) => {
    let next = value;
    let filename;
    if (options && typeof options === 'object') filename = options.filename;
    if (filename && typeof Blob === 'function' && !(value instanceof Blob)) {
      const bytes = value instanceof ArrayBuffer
        ? value
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          : value;
      next = new Blob([bytes], { type: options.contentType || 'application/octet-stream' });
    }
    return filename ? append(name, next, filename) : append(name, next);
  };
  form.getHeaders = () => ({});
  return form;
}

module.exports = FormDataShim;
module.exports.__esModule = true;
