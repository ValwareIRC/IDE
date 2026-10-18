package dev.valware.prism;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Which gadgets the computer has, for the screen that asks what a new widget should
 * show. Fetched the same way the pictures are: through the app's own page, which is
 * already paired (see WidgetShot).
 */
final class WidgetList {
  private static final String TAG = "PrismWidget";
  private static final long PATIENCE_MS = 20_000;

  private WidgetList() {}

  /** A JSON array of { id, name }, or an empty one when the computer cannot be reached. */
  static String fetch(Context context) {
    final String[] out = {"[]"};
    final CountDownLatch done = new CountDownLatch(1);
    new Handler(Looper.getMainLooper()).post(() -> {
      try {
        start(context, (json) -> {
          out[0] = json;
          done.countDown();
        });
      } catch (Throwable t) {
        Log.e(TAG, "could not ask for the gadget list", t);
        done.countDown();
      }
    });
    try {
      done.await(PATIENCE_MS + 5_000, TimeUnit.MILLISECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    return out[0];
  }

  private interface Got {
    void on(String json);
  }

  @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
  private static void start(Context context, Got got) {
    final WebViewAssetLoader loader = WidgetAssets.loader(context);
    final WebView web = new WebView(context.getApplicationContext());
    final boolean[] settled = {false};
    final Handler main = new Handler(Looper.getMainLooper());
    final Runnable[] giveUp = new Runnable[1];

    final Got once = (json) -> {
      if (settled[0]) return;
      settled[0] = true;
      if (giveUp[0] != null) main.removeCallbacks(giveUp[0]);
      main.postDelayed(web::destroy, 50);
      got.on(json == null || json.isEmpty() ? "[]" : json);
    };

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return loader.shouldInterceptRequest(request.getUrl());
      }
    });
    web.addJavascriptInterface(new Object() {
      @JavascriptInterface
      public void gadgets(String json) {
        main.post(() -> once.on(json));
      }

      @JavascriptInterface
      public void failed(String why) {
        Log.w(TAG, "the page could not list gadgets: " + why);
        main.post(() -> once.on("[]"));
      }
    }, "PrismWidgetHost");

    web.measure(View_MEASURE, View_MEASURE);
    web.layout(0, 0, 400, 600);
    web.loadUrl(WidgetAssets.listPage().toString());

    giveUp[0] = () -> once.on("[]");
    main.postDelayed(giveUp[0], PATIENCE_MS);
  }

  /** The size is irrelevant here, but a WebView will not run a page it has never laid out. */
  private static final int View_MEASURE = android.view.View.MeasureSpec.makeMeasureSpec(400, android.view.View.MeasureSpec.EXACTLY);
}
