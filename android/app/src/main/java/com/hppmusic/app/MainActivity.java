package com.hppmusic.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 最近一次拿到的系统栏 insets。
     *
     * 缓存下来是为了让 WebView 侧能**随时**查到当前值：注入时机不可靠
     * （见 injectSafeAreaInsets 的说明），前端需要一个同步的读取入口。
     */
    private Insets lastInsets = Insets.NONE;
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

        // 内容铺满到状态栏/导航栏底下（Android 15 起系统本来就强制如此），
        // 具体留白交给 CSS 的 --safe-*（见 src/mobile/design/tokens.css）。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        final View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            lastInsets = bars;
            injectSafeAreaInsets(bars);
            return windowInsets;
        });
        // 监听器只在下一次 insets 变化时回调，主动请求一次拿到初始值
        ViewCompat.requestApplyInsets(decor);

        // 给 WebView 侧一个同步查询入口。
        // 上面那次注入多半打在还没加载页面的 WebView 上（JS 跑在 about:blank），
        // 页面一加载就丢了 —— 实测重启 App 后 --safe-area-inset-top 直接不存在，
        // 顶部被状态栏盖住。前端启动时会调这里的 getInsets() 补一次。
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new SafeAreaQuery(), "HppSafeArea");
        }
    }

    /** 供前端查询系统栏 insets（单位 dp，对应 CSS 的 px） */
    private final class SafeAreaQuery {
        @JavascriptInterface
        public String getInsets() {
            final float density = getResources().getDisplayMetrics().density;
            return "{\"top\":" + Math.round(lastInsets.top / density)
                    + ",\"bottom\":" + Math.round(lastInsets.bottom / density)
                    + ",\"left\":" + Math.round(lastInsets.left / density)
                    + ",\"right\":" + Math.round(lastInsets.right / density) + "}";
        }
    }

    /**
     * 把系统栏 insets 注入成 CSS 变量。
     *
     * 不用 Capacitor 内置的 SystemBars 注入（已在 capacitor.config.ts 里把
     * insetsHandling 设成 disable）：它按 WebView 版本分叉 —— 老 Chromium 给
     * WebView 加 padding 并把变量设成 0，新 Chromium 才给真值。同一份 CSS 在
     * 两种设备上表现不同，出问题极难定位（本项目已经踩过一次：模拟器正常、
     * 真机顶部被状态栏盖住）。
     *
     * 这里统一由原生给真值，CSS 只管按 --safe-* 留白。
     */
    private void injectSafeAreaInsets(Insets bars) {
        if (bridge == null) return;
        final float density = getResources().getDisplayMetrics().density;
        final String js = "(() => { const s = document.documentElement.style;"
                + " s.setProperty('--safe-area-inset-top', '" + Math.round(bars.top / density) + "px');"
                + " s.setProperty('--safe-area-inset-bottom', '" + Math.round(bars.bottom / density) + "px');"
                + " s.setProperty('--safe-area-inset-left', '" + Math.round(bars.left / density) + "px');"
                + " s.setProperty('--safe-area-inset-right', '" + Math.round(bars.right / density) + "px');"
                + " })()";
        bridge.eval(js, null);
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
