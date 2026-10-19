package com.hppmusic.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;

import java.io.File;

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

    /**
     * 用**系统 DownloadManager** 下载安装包。
     *
     * 不用自写 HTTP 下载的原因：系统下载器有断点续传（网络中断后自动接着下）、
     * 独立的下载通知栏（可以切到别的应用、甚至锁屏）、以及“下载完成点击安装”的标准体验。
     * 自写下载一旦退后台就容易被系统限制，也不支持续传。
     *
     * 返回 `id`，JS 侧用它轮询 `queryDownload` 拿进度。
     */
    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "HppMusic-update.apk");
        String title = call.getString("title", "HppMusic 更新");
        String description = call.getString("description", "正在下载新版本");
        if (url == null || url.isEmpty()) {
            call.reject("下载地址为空", "invalid-url");
            return;
        }
        try {
            DownloadManager manager =
                    (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("系统下载服务不可用", "download-unavailable");
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(title);
            request.setDescription(description);
            request.setMimeType("application/vnd.android.package-archive");
            // 允许移动网络下载（用户主动点的更新，不再二次询问）
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            // 通知栏可见 + 完成后点击安装
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            File target = new File(
                    getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName);
            // 同一文件重复下载时覆盖，避免累积成 (1)(2)
            if (target.exists()) {
                // noinspection ResultOfMethodCallIgnored
                target.delete();
            }
            request.setDestinationInExternalFilesDir(
                    getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
            long id = manager.enqueue(request);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(error.getMessage() == null ? "发起下载失败" : error.getMessage(),
                    "download-failed");
        }
    }

    /** 轮询下载状态：status 为 pending/running/paused/successful/failed。 */
    @PluginMethod
    public void queryDownload(PluginCall call) {
        // ⚠️ 用 getDouble 而不是 getLong：JS 传过来的数字会被反序列化成
        // Double/Integer，getLong 取不到时直接回退默认值 -1，表现为“下载任务无效”。
        Double rawId = call.getDouble("id", -1.0);
        long id = rawId == null ? -1L : rawId.longValue();
        if (id < 0) {
            call.reject("下载任务无效", "invalid-id");
            return;
        }
        try {
            DownloadManager manager =
                    (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            JSObject result = new JSObject();
            if (manager == null) {
                result.put("status", "failed");
                result.put("reason", "no-manager");
                call.resolve(result);
                return;
            }
            DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
            try (Cursor cursor = manager.query(query)) {
                if (cursor == null || !cursor.moveToFirst()) {
                    result.put("status", "unknown");
                    call.resolve(result);
                    return;
                }
                int statusIndex = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                int downloadedIndex = cursor.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                int totalIndex = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                int uriIndex = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
                int reasonIndex = cursor.getColumnIndex(DownloadManager.COLUMN_REASON);

                int status = statusIndex >= 0 ? cursor.getInt(statusIndex) : -1;
                long downloaded = downloadedIndex >= 0 ? cursor.getLong(downloadedIndex) : 0L;
                long total = totalIndex >= 0 ? cursor.getLong(totalIndex) : 0L;
                String localUri = uriIndex >= 0 ? cursor.getString(uriIndex) : null;

                result.put("status", mapDownloadStatus(status));
                result.put("downloadedBytes", downloaded);
                result.put("totalBytes", total < 0 ? 0 : total);
                if (reasonIndex >= 0 && status != DownloadManager.STATUS_SUCCESSFUL) {
                    result.put("reason", cursor.getInt(reasonIndex));
                }
                if (localUri != null && !localUri.isEmpty()) {
                    result.put("localPath", Uri.parse(localUri).getPath());
                }
            }
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(error.getMessage() == null ? "查询下载状态失败" : error.getMessage(),
                    "query-failed");
        }
    }

    private static String mapDownloadStatus(int status) {
        switch (status) {
            case DownloadManager.STATUS_PENDING:
                return "pending";
            case DownloadManager.STATUS_RUNNING:
                return "running";
            case DownloadManager.STATUS_PAUSED:
                // 网络中断/等待重试：系统会自己续传，这里如实告诉 JS 是“暂停中”
                return "paused";
            case DownloadManager.STATUS_SUCCESSFUL:
                return "successful";
            case DownloadManager.STATUS_FAILED:
                return "failed";
            default:
                return "unknown";
        }
    }

    /** 打开系统文件安装界面安装已下载的 APK。 */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path", "");
        if (path == null || path.isEmpty()) {
            call.reject("安装包路径为空", "invalid-path");
            return;
        }
        try {
            File file = new File(path);
            if (!file.isFile()) {
                call.reject("安装包不存在，请重新下载", "missing-file");
                return;
            }
            Context context = getContext();
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O
                    && !context.getPackageManager().canRequestPackageInstalls()) {
                // 未授予“安装未知应用”权限：跳到该应用的权限页，让用户自己开
                Intent settingsIntent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
                settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settingsIntent);
                call.reject("需要先允许安装未知应用", "install-permission");
                return;
            }
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSObject result = new JSObject();
            result.put("started", true);
            call.resolve(result);
        } catch (Throwable error) {
            call.reject(error.getMessage() == null ? "打开安装界面失败" : error.getMessage(),
                    "install-failed");
        }
    }
}
