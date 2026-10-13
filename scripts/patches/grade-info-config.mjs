/**
 * `/user/grade/info` 的标准版配置补丁（构建期注入，供打包与测试共用）。
 *
 * 背景：上游该模块用概念版（lite）签名，自服务端 KCD_0.43.0 起被拒，
 * 返回 error_code=20018；而 20018 在本接口并不代表登录过期，却会被渲染层
 * 误判为会话失效（每分钟弹一次「登录已过期」）。改用标准版配置后同一 token
 * 正常返回 data.d_sec。
 *
 * 为什么不直接改 server 子模块：子模块指向上游 MakcRe/KuGouMusicApi，
 * 没有写权限，改动无法随 fork 分发（clone 后 submodule update 就会还原）。
 * 所以放在这里，由 build-kugou-api.mjs 在打包时套用。
 */

/** 上游原始（概念版）写法。 */
const LITE_UTIL_REQUIRE = "const { cryptoRSAEncrypt, publicLiteRasKey } = require('../util');";

const LITE_CONFIG = [
  "  appId: '3116',",
  "  appKey: 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA',",
  "  clientVer: '10597',",
  '  publicKey: publicLiteRasKey,',
].join('\n');

/** 标准版写法：与上游其它标准版接口一致（同一套 appId/appKey/clientVer）。 */
const STANDARD_CONFIG = [
  "  appId: '1005',",
  "  appKey: 'OIlwieks28dk2k092lksi2UIkp',",
  "  clientVer: '20489',",
  '  publicKey: publicRasKey,',
].join('\n');

const STANDARD_UTIL_REQUIRE = "const { cryptoRSAEncrypt, publicRasKey } = require('../util');";

export const GRADE_INFO_STANDARD_APP_ID = '1005';
export const GRADE_INFO_STANDARD_CLIENT_VER = '20489';

/**
 * 把模块源码改成标准版配置。
 *
 * 返回 `{ contents, patched }`：
 * - `patched: false` 表示上游自己已经用了标准版配置（此时原样返回、不阻断构建）；
 * - 目标不存在且也不是标准版时抛错 —— 补丁必须失败得响，不能静默产出坏包。
 *
 * 输出统一为 LF；输入会先做 CRLF 归一化（子模块是 CRLF 行尾）。
 */
export const applyGradeInfoStandardConfig = (rawSource) => {
  // ⚠️ server 子模块的文件是 CRLF 行尾，多行 needle 不先归一化就匹配不上
  // （实测：构建时看着像正常，其实只是没改成 —— 所以统一在函数内部处理）。
  const source = rawSource.replace(/\r\n/g, '\n');
  if (source.includes(STANDARD_CONFIG)) {
    return { contents: source, patched: false };
  }
  if (!source.includes(LITE_UTIL_REQUIRE) || !source.includes(LITE_CONFIG)) {
    throw new Error('[kugou-api] user_grade_info.js 标准版配置补丁目标已变化');
  }
  return {
    contents: source
      .replace(LITE_UTIL_REQUIRE, STANDARD_UTIL_REQUIRE)
      .replace(LITE_CONFIG, STANDARD_CONFIG),
    patched: true,
  };
};
