/**
 * QQ 登录授权页 URL 补丁（构建期注入，仅移动端打包）。
 *
 * 给 `login_qq_qr_create.js` 加 `mode=url`：直接返回签名好的
 * `m_authorize` 授权页 URL，不在服务端走 ptqrshow 二维码链路。
 * 客户端用 Custom Tab 打开该 URL 即可一键授权（手机装有 QQ 时呼起 QQ App），
 * 全程不出二维码 —— 解决"手机扫码手机不方便"的问题。
 *
 * 授权成功后 QQ 回落 `auth://tauth.qq.com/#access_token=...&openid=...`
 * （response_type=token 的 implicit flow），客户端拦截这个 scheme 导航拿
 * token，再喂给现成的 `/login/qq`（login_qq.js）换酷狗登录态。
 *
 * 为什么不直接改 server 子模块：同 grade-info 补丁 —— 子模块指向上游
 * MakcRe/KuGouMusicApi，改动无法随 fork 分发。且该文件的 onLoad 已被
 * `routeQqLoginThroughNativeHttp` 认领（esbuild 先到先得），必须链进那个
 * 插件，不能另起 onLoad。
 *
 * style=qr 与 format=json 只服务二维码流程：前者强制页面显示二维码，
 * 后者把响应包成 JSON。浏览器/Custom Tab 导航要的是 HTML 页面，故删除。
 */

/** 授权页构造完成、发起请求前的位置（唯一）。 */
const AUTH_REQUEST_NEEDLE = [
  "      const authResp = await axios({",
  '        url: `https://openmobile.qq.com/oauth2.0/m_authorize?${authParams.toString()}`,',
].join('\n');

/** 已打过补丁的标记（幂等）。 */
const PATCHED_MARKER = "mode === 'url'";

export const applyQqAuthorizeUrlMode = (rawSource) => {
  // ⚠️ server 子模块是 CRLF 行尾，多行 needle 不先归一化就匹配不上
  const source = rawSource.replace(/\r\n/g, '\n');
  if (source.includes(PATCHED_MARKER)) {
    return { contents: source, patched: false };
  }
  if (!source.includes(AUTH_REQUEST_NEEDLE)) {
    throw new Error('[kugou-api] login_qq_qr_create.js 授权页补丁目标已变化');
  }
  const injection = [
    "      // mode=url：返回签名好的授权页 URL，供 Custom Tab 打开做一键授权，跳过下方二维码链路。",
    '      // style=qr 强制页面出二维码、format=json 把响应包成 JSON，浏览器导航要 HTML 页面，故删除。',
    "      if (params?.mode === 'url') {",
    "        authParams.delete('style');",
    "        authParams.delete('format');",
    '        answer.status = 200;',
    '        answer.body = {',
    '          url: `https://openmobile.qq.com/oauth2.0/m_authorize?${authParams.toString()}`,',
    '        };',
    '        resolve(answer);',
    '        return;',
    '      }',
    '',
  ].join('\n');
  return {
    contents: source.replace(AUTH_REQUEST_NEEDLE, injection + AUTH_REQUEST_NEEDLE),
    patched: true,
  };
};
