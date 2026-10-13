package com.hppmusic.app;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 三个自定义插件必须在 super.onCreate 之前注册：BridgeActivity 在 super 里
        // 才会去读已注册的插件列表并实例化，晚一步注册的插件不会被挂上。
        registerPlugin(EchoNativePlayerPlugin.class);
        registerPlugin(EchoSharePlugin.class);
        registerPlugin(EchoNativeHttpPlugin.class);
        super.onCreate(savedInstanceState);

        // 只有 debug 包开 WebView 调试：`scripts/device-eval.mjs` 依赖它做真机断言
        // （adb forward + CDP）。release 包开着等于给任何能连 adb 的人一个完整的
        // JS 执行入口，不能留。
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /**
     * 系统返回键的三级处理：
     *  ① WebView 内的浮层（播放页 / 歌词页 / 抽屉）先消费 —— JS 钩子返回 true 即止；
     *  ② 否则按 WebView 历史路由后退（应用是 hash 路由，每条 push 都是历史条目）；
     *  ③ 没有可退的历史就退到后台，不结束 Activity —— 播放由 MediaSessionService 继续。
     *
     * ⚠️ Capacitor 的 BridgeActivity 自己不接返回键，不覆写这里的话默认行为是
     * 直接 finish()：在任何子页面按返回都是杀进程，而不是路由后退。
     */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (bridge == null) {
            super.onBackPressed();
            return;
        }
        // evaluateJavascript 是异步的，但整个决策只在回调里做一次，不存在竞态；
        // 页面未就绪时回调收到 null，按「没有浮层消费」继续走路由/退后台。
        bridge.eval(
            "JSON.stringify((window.__echoMobileBack && window.__echoMobileBack()) || false)",
            (result) -> {
                if ("true".equals(result)) return;
                WebView webView = bridge.getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                moveTaskToBack(true);
            });
    }
}
