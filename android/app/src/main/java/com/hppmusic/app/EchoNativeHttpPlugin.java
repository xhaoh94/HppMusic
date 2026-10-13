package com.hppmusic.app;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;

/**
 * 直连 HTTP 插件：给需要「完整响应头」的场景用（目前是 QQ 扫码登录）。
 *
 * 为什么不用 CapacitorHttp：
 * - Android 的 HttpURLConnection 会把多条 Set-Cookie 合并，CapacitorHttp 只回传其中一条。
 *   实测 xlogin 在 Node 下返回 8 个 cookie（pt_login_sig 等），经 CapacitorHttp 只剩
 *   pt_user_id，导致扫码轮询因缺少 pt_login_sig 直接失败。
 * - CapacitorHttp 也无法关闭自动重定向，而 QQ 登录的票据跳转需要读 Location。
 *
 * 这里直接用 HttpURLConnection 读 getHeaderFields()，保留全部 Set-Cookie 与 Location，
 * 并支持 followRedirects=false。响应体一律以 base64 返回，二进制安全。
 */
@CapacitorPlugin(name = "EchoNativeHttp")
public final class EchoNativeHttpPlugin extends Plugin {
    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String data = call.getString("data", null);
        final boolean followRedirects = call.getBoolean("followRedirects", true);
        Integer timeoutValue = call.getInt("timeoutMs", 20_000);
        final int timeoutMs = timeoutValue == null ? 20_000 : timeoutValue;
        final JSObject headerInput = call.getObject("headers", new JSObject());

        if (url == null || url.isEmpty()) {
            call.reject("url 不能为空", "native-http-invalid");
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setRequestMethod(method);
                connection.setInstanceFollowRedirects(followRedirects);
                connection.setConnectTimeout(timeoutMs);
                connection.setReadTimeout(timeoutMs);
                java.util.Iterator<String> keys = headerInput.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    Object value = headerInput.get(key);
                    if (value == null) continue;
                    String lower = key.toLowerCase();
                    // 交给底层自己算
                    if (lower.equals("content-length") || lower.equals("host")) continue;
                    connection.setRequestProperty(key, String.valueOf(value));
                }
                if (data != null) {
                    connection.setDoOutput(true);
                    if (connection.getRequestProperty("Content-Type") == null) {
                        connection.setRequestProperty("Content-Type", "application/json");
                    }
                    byte[] payload = data.getBytes("UTF-8");
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(payload);
                    }
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                byte[] body = readAll(stream);

                JSObject result = new JSObject();
                result.put("status", status);
                result.put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));

                JSObject headers = new JSObject();
                JSArray cookies = new JSArray();
                Map<String, List<String>> headerFields = connection.getHeaderFields();
                if (headerFields != null) {
                    for (Map.Entry<String, List<String>> entry : headerFields.entrySet()) {
                        String name = entry.getKey();
                        if (name == null) continue;
                        List<String> values = entry.getValue();
                        if (values == null) continue;
                        JSArray array = new JSArray();
                        for (String value : values) array.put(value);
                        headers.put(name.toLowerCase(), array);
                        if ("set-cookie".equalsIgnoreCase(name)) {
                            for (String value : values) cookies.put(value);
                        }
                    }
                }
                result.put("headers", headers);
                result.put("cookies", cookies);
                call.resolve(result);
            } catch (Throwable error) {
                String message = error.getMessage();
                call.reject(message == null ? "原生 HTTP 请求失败" : message, "native-http-error");
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private static byte[] readAll(InputStream stream) throws java.io.IOException {
        if (stream == null) return new byte[0];
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
}
