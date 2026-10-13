import './polyfills';
import { util } from '@/generated/kugou-api.js';

export interface DeviceIdentity {
  guid: string;
  mid: string;
  mac: string;
  webglHash: string;
  /** 仅本机保存，不随身份上送。用于给 webglHash 加随机性，见 getDeviceIdentity。 */
  fingerprintSalt?: string;
}

const STORAGE_KEY = 'echo.mobile.device';

/**
 * 本机 MAC，**每个安装必须唯一**。
 *
 * ⚠️ 不能写死成固定值：上游是按 MAC 判重的。所有移动端设备用同一个值，
 * 会让第二台设备（以及每次重装）都被当成「已经注册过」，`/register/dev`
 * 于是返回 `{status:1, data:[]}`（没有 dfid），启动流程判定注册失败、落到
 * 错误页。实测把 MAC 换成随机值后立刻拿到 dfid：
 *   02:00:00:00:00:00 → {status:1,data:[]}
 *   02:C4:A9:B2:2D:26 → {status:1,data:{dfid:"3we4..."}}
 *
 * 所以按「首次生成一次、之后持久化复用」处理：同一安装内跨启动稳定，
 * 全新安装拿到新值。前缀 02 是本地管理地址，避免与真实网卡冲突。
 *
 * 旧版本写死过 02:00:00:00:00:00，老安装已在 localStorage 里存了这个值，
 * 因此 resolveMac 要做一次迁移，否则已装的设备修不好。
 */
const LEGACY_FALLBACK_MAC = '02:00:00:00:00:00';
const randomMac = (): string =>
  `02:${Array.from({ length: 5 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
    .join(':')}`.toUpperCase();

const resolveMac = (saved?: string): string => {
  const value = (saved ?? '').toUpperCase();
  if (!value || value === LEGACY_FALLBACK_MAC) return randomMac();
  return value;
};

/**
 * webglHash 的盐：只在**首次生成时**随机一次并持久化。
 *
 * `generateWebGLHash()` 在 WebView 里是真跑 canvas 取 GPU 信息，算出的是
 * **硬件确定值** —— 卸载重装后还是同一个。加盐可保证全新安装拿到新指纹，
 * 同一安装内保持稳定。
 *
 * ⚠️ 但注意：实测确认的判重关键其实是 **MAC**（只改 MAC、webglHash 不动，
 * 就能立刻拿到 dfid；见 resolveMac 的说明）。这里加盐是并行保险，
 * 别把 MAC 的修复当成「已经由加盐解决」而漏掉。
 */
const saltedWebglHash = (base: string, salt: string): string =>
  `0${BigInt(`0x${util.cryptoMd5(`${base}:${salt}`).slice(0, 15)}`) % 1000000000000000000n}`;

const read = (): Partial<DeviceIdentity> => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DeviceIdentity>;
  } catch {
    return {};
  }
};

let cached: DeviceIdentity | null = null;

/**
 * 生成顺序对齐 src/main/server.ts：guid → md5(guid) → mid，webgl 独立生成，全部持久化。
 */
export const getDeviceIdentity = (): DeviceIdentity => {
  if (cached) return cached;

  const saved = read();
  const guid = saved.guid || util.cryptoMd5(util.getGuid());
  const salt = saved.fingerprintSalt || util.getGuid();
  const identity: DeviceIdentity = {
    guid,
    mid: saved.mid || util.calculateMid(guid),
    mac: resolveMac(saved.mac),
    webglHash: saved.webglHash || saltedWebglHash(util.generateWebGLHash(), salt),
    fingerprintSalt: salt,
  };

  cached = identity;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // 写不进去只影响下次启动复用同一身份，不阻塞本次
  }
  return identity;
};
