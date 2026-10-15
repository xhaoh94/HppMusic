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
    /**
     * 关掉 Capacitor 自带的系统栏 insets 注入，改由 MainActivity 统一注入。
     *
     * 它的行为**随 WebView 版本分叉**：老 Chromium 给 WebView 加 padding 并把
     * --safe-area-inset-* 设成 0，新 Chromium 才给真值。同一份 CSS 在两种设备上
     * 表现不同 —— 真机上顶部被状态栏盖住、而模拟器上一切正常，就是这么来的。
     * 交给原生统一给值后，行为在所有设备上一致。
     */
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
};

export default config;
