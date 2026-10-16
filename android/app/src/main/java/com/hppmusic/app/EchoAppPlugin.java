package com.hppmusic.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 应用级杂项能力。
 *
 * 为什么需要 `moveToBackground`：返回键在根页签上的约定是「第一次提示、
 * 两秒内再按才退到后台」。之前的实现是 JS 侧 `return false` 交给原生兜底，
 * 但 Capacitor 的兜底是**按 WebView 历史后退**（有历史时才退后台）——
 * 结果真机上按返回在两个页面之间来回横跳（App 的返回逻辑和 WebView
 * 后退互相打架）。所以根页签的返回必须由 JS 显式消费，退出动作走这里。
 */
@CapacitorPlugin(name = "EchoApp")
public final class EchoAppPlugin extends Plugin {

    /** 退到后台（不杀进程），音乐继续播。 */
    @PluginMethod
    public void moveToBackground(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }
}
