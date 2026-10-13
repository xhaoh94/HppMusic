import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hppmusic.app',
  appName: 'HppMusic',
  webDir: 'dist',
  android: {
    // 上游音频与图片大量走 http，WebView 默认会拦（同 EchoMusic 的处理）。
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: {
      /**
       * 必须开：内核的 utils/request.ts 走 axios，在 WebView 里会退化成 XHR，
       * 直连 gateway.kugou.com 会被 CORS 拦掉（对方不返回 Access-Control-Allow-Origin）。
       * 开启后 XHR/fetch 由 native-bridge 重写走原生 HTTP，同时绕开浏览器
       * 禁止设置 User-Agent 的限制（改写为 x-cap-user-agent）。
       */
      enabled: true,
    },
  },
};

export default config;
