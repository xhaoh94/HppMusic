package com.hppmusic.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Native clipboard and share bridge. Cold-start links are retained until JS reads them. */
@CapacitorPlugin(name = "EchoShare")
public final class EchoSharePlugin extends Plugin {
    private String pendingText = "";

    @Override
    public void load() {
        super.load();
        acceptIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        acceptIntent(intent);
    }

    private void acceptIntent(Intent intent) {
        if (intent == null) return;
        String text = "";
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            text = intent.getData().toString();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            text = intent.getStringExtra(Intent.EXTRA_TEXT);
        }
        if (text == null || text.trim().isEmpty()) return;
        pendingText = text.trim();
        notifyListeners("shareOpen", new JSObject().put("text", pendingText));
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        String text = pendingText;
        pendingText = "";
        call.resolve(new JSObject().put("text", text));
    }

    @PluginMethod
    public void copy(PluginCall call) {
        String text = call.getString("text", "");
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            call.resolve(new JSObject().put("ok", false));
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("HppMusic", text));
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        String text = "";
        if (clipboard != null && clipboard.hasPrimaryClip()) {
            ClipData data = clipboard.getPrimaryClip();
            if (data != null && data.getItemCount() > 0) {
                CharSequence value = data.getItemAt(0).coerceToText(getContext());
                if (value != null) text = value.toString();
            }
        }
        call.resolve(new JSObject().put("text", text));
    }

    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text", "");
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, text);
        getActivity().startActivity(Intent.createChooser(intent, "分享至"));
        call.resolve(new JSObject().put("ok", true));
    }
}
