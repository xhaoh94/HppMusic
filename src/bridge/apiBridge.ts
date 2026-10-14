/**
 * 桌面端 `window.electron.api.request` 的移动端实现。
 *
 * 移植策略是**复用而非重写**：路由表与 HTTP 封装直接来自 ../../server（由
 * scripts/build-kugou-api.mjs 打包进 src/generated），这里只补主进程那一层壳
 * —— cookie 合并、参数字符串化、模块调用与响应组装，语义逐条对齐
 * src/main/server.ts 的 handleApiRequest。
 */
import './polyfills';
import { Buffer } from 'buffer';
import { mergeApiRequestBody } from '@shared/apiRequestMerge';
import { modules, util } from '@/generated/kugou-api.js';
import { getDeviceIdentity } from './deviceIdentity';
import { createNativePlayerBridge } from './nativePlayer';
import { createCloudApi, createRecognizeApi } from './deviceApis';
import { createNativeShareApi } from './shareApi';
import { createExternalApi } from './externalApi';
import { createSettingsBackupApi } from './backupApis';
import { createAudioEffectsApi } from './audioEffects';
import {
  createApiServerApi,
  createAppInfoApi,
  createIpcRendererApi,
  createLogApi,
  createNetworkApi,
  createStorageApi,
  createWindowControlApi,
} from './runtimeApis';

type ModuleFn = (params: Record<string, unknown>, createRequest: (config: unknown) => unknown) => Promise<unknown>;

interface ApiRequest {
  method: string;
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
}

interface ApiResponse {
  status: number;
  body: unknown;
  cookie?: string[];
  headers?: Record<string, string>;
}

const SERVER_DEV = 'EchoMusic';

let ready = false;
const known = new Set(Object.keys(modules));

/** 与主进程 parseAuthCookie 一致：`a=1;b=2` → { a: '1', b: '2' }。 */
const parseAuthCookie = (authHeader?: string): Record<string, string> => {
  if (!authHeader) return {};
  const result: Record<string, string> = {};
  authHeader.split(';').forEach((pair) => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex < 1) return;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key && value) result[key] = value;
  });
  return result;
};

/** 与主进程 buildDefaultCookies 一致，只是设备身份来自 localStorage。 */
const buildDefaultCookies = (): Record<string, string> => {
  const device = getDeviceIdentity();
  return {
    KUGOU_API_PLATFORM: 'lite',
    KUGOU_API_MID: device.mid,
    KUGOU_API_GUID: device.guid,
    KUGOU_API_DEV: SERVER_DEV,
    KUGOU_API_MAC: device.mac.toUpperCase(),
    KUGOU_API_WEBGL: device.webglHash,
  };
};

/**
 * 生成的模块表。
 *
 * 生成的 `kugou-api.js` 把 routes 写成了**字面量对象**，TypeScript 会据此推出一个
 * 精确键集合的类型，用 `string` 下标就报 TS7053（"No index signature"）。
 * 这里的键本来就是在运行时按请求 URL 查的，所以显式收敛成索引签名。
 */
const moduleTable = modules as Record<string, ModuleFn | undefined>;

/** 与主进程 matchModule 一致：去掉查询串、容忍尾部斜杠。 */
const matchModule = (url: string): ModuleFn | null => {
  const pathname = url.split('?')[0];
  const exact = moduleTable[pathname];
  if (exact) return exact;
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return moduleTable[trimmed] ?? null;
};

/**
 * 把二进制请求体归一化成 **Buffer**。
 *
 * ⚠️ 这一步看着多余（Uint8Array 也是二进制），但对上游是**必需**的：
 *
 * 1. **签名**：`server/util/helper.js` 的 `signatureAndroidParams(params, data)`
 *    对二进制有专门分支：
 *    ```js
 *    if (Buffer.isBuffer(data)) \{ 用原始字节参与 MD5 \}
 *    return cryptoMd5(`${str}${paramsString}${data || ''}${str}`);
 *    ```
 *    传 `Uint8Array` 时 `Buffer.isBuffer` 为 false，会掉进字符串分支，
 *    而 `request.js` 那行 `typeof data === 'object' ? JSON.stringify(data)`
 *    会把字节数组变成 `{"0":7,"1":7,...}` —— **签出来完全是另一个值**，
 *    上游直接以 `error_code: 40000` 拒绝。
 * 2. **请求体**：`Buffer` 是 `Uint8Array` 的子类，
 *    Capacitor 的 `convertBody` 才会把它当二进制转 base64 交给原生；
 *    传裸 `Uint8Array` 时实测收到的字节数不对（32000 字节约变成 308891 字节）。
 *
 * 实测：听歌识曲（POST 320KB PCM 到 /audio/match）在转 Buffer 前一直是 40000。
 */
const toBinaryBody = (value: ArrayBuffer | ArrayBufferView): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  const view = value as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
};

const isBinary = (value: unknown): boolean =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

/** 主进程用 serializeModuleErrorBody 把 Error 转成可序列化结构。 */
const serializeErrorBody = (body: unknown): unknown => {
  if (body instanceof Error) return { status: 0, msg: body.message, name: body.name };
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      out[key] = value instanceof Error ? { message: value.message, name: value.name } : value;
    }
    return out;
  }
  return body;
};

/**
 * 音质授权路由已改回概念版（lite）身份。
 *
 * 曾尝试对 `/song/url*` 与 `/privilege*` 临时改用标准版身份，想让 320/无损 拿到地址，
 * 实测无效（同一账号同一首歌仍返回 status=2 付费拦截），而且标准版身份下连 128
 * 都会被标成 require_vip_type='concept'，风险大于收益，故回滚。
 * 移动端的音质置灰改由下方的「付费拦截记账」驱动。
 */

/**
 * 音质拒绝记账（供移动端音质弹层置灰用）。
 *
 * 背景：账号持有概念版 VIP（busi_vip.svip.is_vip=1），音质权限接口因此把
 * 320/无损 标成 require_vip_type='concept'，共享的 getQualityAccessReason 判定
 * “已有概念版 VIP” → 不置灰。但上游取链接口（tracker/v5/url）对这两档返回
 * status=2（需要付费，all_quality_free=0），根本拿不到地址，播放只能静默降级 128。
 *
 * 桌面端能看到置灰是因为标准版身份下概念版 VIP 不计入；移动端概念版身份下
 * 唯一可靠的事实就是“上游实际拒绝了哪档音质”，所以用本次真实结果记账。
 * 一旦某档后来取到地址，立即从记账里清除（用户开通会员后会自动恢复）。
 */
type QualityDenialMap = Record<string, Record<string, string>>;

const qualityDenialMap = (): QualityDenialMap => {
  const target = window as unknown as { __echoQualityDenied?: QualityDenialMap };
  target.__echoQualityDenied = target.__echoQualityDenied ?? {};
  return target.__echoQualityDenied;
};

/** 取链接口的响应：有 url 即成功，否则看是否属于付费拦截。 */
const recordQualityOutcome = (params: Record<string, unknown>, body: unknown): void => {
  const hash = String(params?.hash ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const quality = String(params?.quality ?? '').trim();
  if (!hash || !quality) return;
  const result = body && typeof body === 'object' ? (body as Record<string, any>) : {};
  const hasUrl = Boolean(
    result.url || (Array.isArray(result.backupUrl) && result.backupUrl.length > 0),
  );
  const bucket = (qualityDenialMap()[hash] ??= {});
  if (hasUrl) {
    delete bucket[quality];
    return;
  }
  // status=2：上游标记“需要付费”；pay_block_tpl / auth_through 是同一拦截的其它表现
  const payBlocked =
    Number(result.status) === 2 ||
    Boolean(result.trans_param?.pay_block_tpl) ||
    Array.isArray(result.auth_through);
  if (payBlocked) bucket[quality] = '该音质需要付费会员，当前账号暂无权限';
};

const needsQualityLedger = (url: string): boolean => /^\/song\/url/.test(String(url || '').split('?')[0]);

export const handleApiRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  if (!ready) return { status: 503, body: { code: 503, msg: 'Service not ready' } };

  const moduleFn = matchModule(request.url);
  if (!moduleFn) {
    console.warn(`[api-bridge] 没有对应模块: ${request.url}`);
    return { status: 404, body: { code: 404, data: null, msg: 'Not Found' } };
  }

  const defaultCookies = buildDefaultCookies();
  const authCookies = parseAuthCookie(
    request.headers?.Authorization ?? request.headers?.authorization,
  );

  // Express 的 query 全是字符串；部分 module 依赖 .split() 等字符串方法
  const stringifiedParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request.params || {})) {
    stringifiedParams[key] =
      value === null || value === undefined
        ? value
        : typeof value === 'object'
          ? value
          : String(value);
  }

  const { cookie: paramCookie, ...restParams } = stringifiedParams;
  const cookieFromParams =
    typeof paramCookie === 'string'
      ? parseAuthCookie(paramCookie)
      : (paramCookie as Record<string, string> | undefined) || {};

  const query: Record<string, unknown> = {
    cookie: { ...defaultCookies, ...cookieFromParams, ...authCookies },
    ...restParams,
  };

  if (request.data !== undefined && request.data !== null) {
    if (isBinary(request.data)) {
      // 必须转 Buffer：签名与请求体两处都依赖它（详见 toBinaryBody 的注释）
      query.data = toBinaryBody(request.data as ArrayBuffer | ArrayBufferView);
    } else {
      query.body = request.data;
      if (typeof request.data === 'object' && !Array.isArray(request.data)) {
        mergeApiRequestBody(query, request.data as Record<string, unknown>);
      }
    }
  }

  // Authorization 始终拥有最高优先级
  query.cookie = { ...(query.cookie as Record<string, string>), ...authCookies };

  try {
    const moduleResponse = (await moduleFn(query, (config: unknown) => {
      (config as Record<string, unknown>).ip = '';
      return util.createRequest(config);
    })) as ApiResponse;

    if (needsQualityLedger(request.url)) recordQualityOutcome(query, moduleResponse?.body);

    return {
      status: moduleResponse.status || 200,
      body: moduleResponse.body,
      cookie: moduleResponse.cookie,
      headers: moduleResponse.headers,
    };
  } catch (error) {
    const failure = error as Partial<ApiResponse> | undefined;
    if (!failure?.body) {
      // 别把"模块抛异常"伪装成 404 —— 上游 404 和本地执行失败必须能区分，
      // 否则排查时会一路怀疑路由匹配。
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[api-bridge] 模块执行失败 ${request.url}:`,
        message,
        error instanceof Error ? error.stack : error,
      );
      return { status: 502, body: { code: 502, data: null, msg: message } };
    }
    return {
      status: failure.status || 502,
      body: serializeErrorBody(failure.body),
      cookie: failure.cookie,
      headers: failure.headers,
    };
  }
};

/**
 * 挂到 window.electron 上。渲染层只认 window.electron.api.request
 * （src/renderer/utils/request.ts:253/268），其余命名空间暂未实现，
 * 一旦被碰就点名报出来，避免静默拿到 undefined 再莫名崩在别处。
 */
export const initApiBridge = (options: { version?: string } = {}) => {
  util.applyCliOverrides(['--platform=lite']);
  (process.env as Record<string, string>).KUGOU_API_DEV = SERVER_DEV;
  ready = true;

  const target = window as unknown as { electron?: Record<string, unknown> };
  const electron = target.electron ?? {};

  // 'android' 让 `=== 'darwin' / 'win32' / 'linux'` 那批桌面判断全部落空，
  // 桌面专属 UI（标题栏红绿灯、Windows 特效、全局快捷键）自然不出现。
  electron.platform = 'android';
  electron.isWayland = false;
  electron.api = { ...((electron.api as Record<string, unknown>) ?? {}), request: handleApiRequest };
  electron.storage = createStorageApi();
  electron.log = createLogApi();
  electron.appInfo = createAppInfoApi(options.version ?? '0.0.0-mobile');
  electron.apiServer = createApiServerApi();
  electron.network = createNetworkApi();
  const nativePlayer = createNativePlayerBridge();
  electron.player = nativePlayer.player;
  electron.mediaControls = nativePlayer.mediaControls;
  electron.cloud = createCloudApi();
  electron.recognize = createRecognizeApi();
  electron.share = createNativeShareApi();
  electron.settingsBackup = createSettingsBackupApi();
  electron.external = createExternalApi();
  electron.audioEffects = createAudioEffectsApi();
  electron.ipcRenderer = createIpcRendererApi();
  electron.windowControl = createWindowControlApi();

  const warned = new Set<string>();
  target.electron = new Proxy(electron, {
    get(source, prop) {
      if (prop in source) return source[prop as string];
      if (typeof prop === 'symbol') return undefined;
      // 只提醒一次，否则一个未实现的命名空间会在每次渲染时刷屏
      if (!warned.has(String(prop))) {
        warned.add(String(prop));
        console.info(`[api-bridge] window.electron.${String(prop)} 尚未在移动端实现`);
      }
      return undefined;
    },
  });

  console.info(`[api-bridge] 就绪，可用模块 ${known.size} 个，设备 mid=${getDeviceIdentity().mid}`);
  return { ready, moduleCount: known.size };
};
