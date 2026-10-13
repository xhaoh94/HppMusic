/**
 * axios 兼容层：把 QQ 扫码登录模块的原生 axios 调用改走 CapacitorHttp。
 *
 * 为什么需要它：
 * WebView 里 axios 退回 XHR 适配器，而浏览器禁止设置 `Cookie` / `Referer` /
 * `User-Agent` 这类禁止头 —— 实测 `https://xui.ptlogin2.qq.com/ssl/ptqrshow`
 * 在 fetch/XHR 路径下返回 403（Cookie 被丢弃），走 CapacitorHttp 原生请求则 200，
 * 结果是 QQ 二维码一直显示“加载失败”。CapacitorHttp 由原生侧发请求，
 * 可以如实带上这些头。
 *
 * 只用于 server/module/login_qq_qr_*.js：它们需要
 * - 请求头 Cookie / Referer / User-Agent 真实生效
 * - 读响应的 `set-cookie`、`location`
 * - `responseType: 'arraybuffer'` 拿二维码 PNG
 * 其它模块仍用打包内的 axios，不受影响。
 *
 * 支持的 axios 语义：可调用形式 `axios(config)`、`axios.get`、`axios.post`、
 * `validateStatus`、`params`、`responseType`、`transformResponse`（忽略）。
 * 不支持：`proxy`、`maxRedirects`（原生层自行跟随重定向）。
 */

const NOTICE_ONCE = new Set();

const getHttp = () =>
  globalThis.__ECHO_CAP_HTTP__ ||
  (globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.CapacitorHttp) ||
  null;

/** EchoNativeHttp：能拿到全部 Set-Cookie / Location，也能关闭重定向跟随。 */
const getNativeHttp = () =>
  (globalThis.Capacitor && globalThis.Capacitor.Plugins && globalThis.Capacitor.Plugins.EchoNativeHttp) ||
  null;

const decodeBase64 = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const toBuffer = (bytes) => (typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes));

const decodeUtf8 = (bytes) => {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

const normalizeRequestHeaders = (headers) => {
  const out = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    // 交给原生层自己算长度与 Host
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'host') return;
    out[key] = String(value);
  });
  return out;
};

const normalizeResponseHeaders = (headers) => {
  const out = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const lower = key.toLowerCase();
    // axios 把 set-cookie 归一成数组，模块按 forEach 使用
    out[lower] =
      lower === 'set-cookie' && !Array.isArray(value) ? [String(value)] : value;
  });
  return out;
};

const buildUrl = (url, params) => {
  if (!params) return url;
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    search.append(key, String(value));
  });
  const query = search.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

const request = async (config) => {
  const options = typeof config === 'string' ? { url: config } : config || {};
  const native = getNativeHttp();
  const http = getHttp();
  if (!native && (!http || typeof http.request !== 'function')) {
    throw new Error('CapacitorHttp 不可用，无法发送 QQ 登录请求');
  }
  if (options.proxy && !NOTICE_ONCE.has('proxy')) {
    NOTICE_ONCE.add('proxy');
    console.info('[axios-native] 忽略 proxy 配置：移动端代理走系统的网络设置');
  }

  const responseType = options.responseType === 'arraybuffer' ? 'arraybuffer' : undefined;
  const url = buildUrl(String(options.url || ''), options.params);
  const method = String(options.method || 'get').toUpperCase();
  const headers = normalizeRequestHeaders(options.headers);
  const body = options.data;
  const serialized =
    body === undefined || body === null
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  if (serialized !== null && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const timeout =
    Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : undefined;
  // maxRedirects: 0 表示不要跟随重定向（QQ 票据跳转需要读 Location）
  const followRedirects = options.maxRedirects === 0 ? false : true;

  let status = 0;
  let responseHeaders = {};
  let data;

  if (native && typeof native.request === 'function') {
    const raw = await native.request({
      url,
      method,
      headers,
      ...(serialized === null ? {} : { data: serialized }),
      followRedirects,
      ...(timeout ? { timeoutMs: timeout } : {}),
    });
    status = Number(raw.status ?? 0);
    // 原生侧给的是「头名 -> 值数组」，保留数组形态（set-cookie 可能多条）
    Object.entries(raw.headers || {}).forEach(([key, value]) => {
      const lower = String(key).toLowerCase();
      responseHeaders[lower] = Array.isArray(value) && value.length === 1 ? value[0] : value;
    });
    if (Array.isArray(raw.cookies) && raw.cookies.length) {
      responseHeaders['set-cookie'] = raw.cookies;
    }
    const bytes = decodeBase64(String(raw.bodyBase64 || ''));
    data = responseType === 'arraybuffer' ? toBuffer(bytes) : decodeUtf8(bytes);
  } else {
    if (options.maxRedirects !== undefined && !NOTICE_ONCE.has('redirect')) {
      NOTICE_ONCE.add('redirect');
      console.info('[axios-native] 忽略 maxRedirects：原生请求会自行跟随重定向');
    }
    const payload = {
      url,
      method,
      headers,
      responseType,
      ...(serialized === null ? {} : { data: serialized }),
      ...(timeout ? { readTimeout: timeout, connectTimeout: timeout } : {}),
    };
    const raw = await http.request(payload);
    status = Number(raw.status ?? 0);
    responseHeaders = normalizeResponseHeaders(raw.headers);
    data = raw.data;
    if (responseType === 'arraybuffer' && typeof data === 'string') data = toBuffer(decodeBase64(data));
  }

  const response = {
    data,
    status,
    statusText: '',
    headers: responseHeaders,
    config: options,
    request: {},
  };

  const validateStatus =
    typeof options.validateStatus === 'function'
      ? options.validateStatus
      : (status) => status >= 200 && status < 300;

  if (!validateStatus(response.status)) {
    const error = new Error(`Request failed with status code ${response.status}`);
    error.name = 'AxiosError';
    error.isAxiosError = true;
    error.config = options;
    error.response = response;
    // 上游拒绝时把响应体一并带上，便于排查（原 axios 同样挂在 error.response.data）
    throw error;
  }
  return response;
};

const axios = (config) => request(config);

axios.request = request;
axios.get = (url, config) => request({ ...(config || {}), url, method: 'get' });
axios.delete = (url, config) => request({ ...(config || {}), url, method: 'delete' });
axios.head = (url, config) => request({ ...(config || {}), url, method: 'head' });
axios.post = (url, data, config) => request({ ...(config || {}), url, method: 'post', data });
axios.put = (url, data, config) => request({ ...(config || {}), url, method: 'put', data });
axios.patch = (url, data, config) => request({ ...(config || {}), url, method: 'patch', data });
axios.defaults = {};
axios.isAxiosError = (value) => Boolean(value && value.isAxiosError);

module.exports = axios;
module.exports.default = axios;
module.exports.__esModule = true;
