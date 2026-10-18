package dev.valware.prism;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;

/**
 * The app's own files, served at the address Capacitor uses (http://localhost, see
 * capacitor.config.json). The same address means the same origin, and so the pairing
 * the app has already done — which is how a widget reaches the computer without a
 * second pairing or a second way of speaking to it.
 */
final class WidgetAssets {
  private WidgetAssets() {}

  static WebViewAssetLoader loader(Context context) {
    return new WebViewAssetLoader.Builder()
        .setDomain("localhost")
        .setHttpAllowed(true)
        .addPathHandler("/", new Public(context))
        .build();
  }

  /** The page, for one gadget, with nothing else on it. */
  static Uri pageFor(String gadgetId, int width, int height, @Nullable String doCall) {
    return Uri.parse("http://localhost/index.html")
        .buildUpon()
        .appendQueryParameter("widget", gadgetId)
        .appendQueryParameter("w", String.valueOf(width))
        .appendQueryParameter("h", String.valueOf(height))
        .appendQueryParameter("do", doCall == null ? "" : doCall)
        .build();
  }

  /** The page, asked only for the list of gadgets. */
  static Uri listPage() {
    return Uri.parse("http://localhost/index.html").buildUpon().appendQueryParameter("widget", "list").build();
  }

  /** Capacitor keeps the app's files under assets/public. */
  private static final class Public implements WebViewAssetLoader.PathHandler {
    private final Context context;

    Public(Context context) {
      this.context = context.getApplicationContext();
    }

    @Nullable
    @Override
    public WebResourceResponse handle(@NonNull String path) {
      String rel = path.startsWith("/") ? path.substring(1) : path;
      if (rel.isEmpty()) rel = "index.html";
      try {
        InputStream in = context.getAssets().open("public/" + rel);
        return new WebResourceResponse(mimeOf(rel), null, in);
      } catch (IOException e) {
        return null;
      }
    }

    private static String mimeOf(String name) {
      if (name.endsWith(".html")) return "text/html";
      if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
      if (name.endsWith(".css")) return "text/css";
      if (name.endsWith(".json")) return "application/json";
      if (name.endsWith(".svg")) return "image/svg+xml";
      if (name.endsWith(".png")) return "image/png";
      if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
      if (name.endsWith(".webp")) return "image/webp";
      if (name.endsWith(".woff2")) return "font/woff2";
      if (name.endsWith(".woff")) return "font/woff";
      if (name.endsWith(".ttf")) return "font/ttf";
      if (name.endsWith(".wasm")) return "application/wasm";
      return "application/octet-stream";
    }
  }
}
