package dev.valware.prism;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Takes the picture a widget shows.
 *
 * A home screen widget cannot run a web page, and everything that knows how to reach
 * the computer — the pairing, the encrypted channel — lives in the app's page as
 * JavaScript. So rather than building a second way to talk to Prism, this opens the
 * app's own page in a WebView nobody sees, at the same address Capacitor uses, which
 * means it is already paired. The page is asked to show one gadget and nothing else;
 * when it says it is ready, the WebView is drawn onto a bitmap.
 *
 * Everything here happens on the main thread, because a WebView insists on it.
 */
final class WidgetShot {
  private static final String TAG = "PrismWidget";
  /** The page is given this long to connect, fetch and draw before the attempt is given up on. */
  private static final long PATIENCE_MS = 25_000;

  /** What the page reported along with the picture. */
  static final class Result {
    final Bitmap bitmap;
    final String title;
    /** The gadget's declared buttons, as JSON; empty when it declares none. */
    final String actions;
    final String problem;

    Result(@Nullable Bitmap bitmap, String title, String actions, @Nullable String problem) {
      this.bitmap = bitmap;
      this.title = title;
      this.actions = actions;
      this.problem = problem;
    }
  }

  private WidgetShot() {}

  /**
   * Opens the app's page for one gadget and draws it.
   *
   * @param doCall a handler to run on the gadget before the picture is taken, or null
   */
  static Result take(Context context, String gadgetId, int width, int height, @Nullable String doCall) {
    final Result[] out = new Result[1];
    final CountDownLatch done = new CountDownLatch(1);
    final int w = Math.max(160, width);
    final int h = Math.max(100, height);

    new Handler(Looper.getMainLooper()).post(() -> {
      try {
        start(context, gadgetId, w, h, doCall, (result) -> {
          out[0] = result;
          done.countDown();
        });
      } catch (Throwable t) {
        Log.e(TAG, "could not open the page", t);
        out[0] = new Result(null, "", "[]", t.getMessage() == null ? "Something went wrong" : t.getMessage());
        done.countDown();
      }
    });

    try {
      if (!done.await(PATIENCE_MS + 5_000, TimeUnit.MILLISECONDS)) {
        return new Result(null, "", "[]", "Prism did not answer");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return new Result(null, "", "[]", "Interrupted");
    }
    return out[0] == null ? new Result(null, "", "[]", "Prism is not reachable") : out[0];
  }

  private interface Finished {
    void on(Result result);
  }

  @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
  private static void start(Context context, String gadgetId, int width, int height, @Nullable String doCall, Finished finished) {
    final WebViewAssetLoader loader = WidgetAssets.loader(context);

    final WebView web = new WebView(context.getApplicationContext());
    final boolean[] settled = {false};
    final Handler main = new Handler(Looper.getMainLooper());

    final Runnable[] giveUp = new Runnable[1];
    final Finished once = (result) -> {
      if (settled[0]) return;
      settled[0] = true;
      if (giveUp[0] != null) main.removeCallbacks(giveUp[0]);
      main.postDelayed(web::destroy, 50);
      finished.on(result);
    };

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(true);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return loader.shouldInterceptRequest(request.getUrl());
      }
    });
    web.addJavascriptInterface(new Object() {
      /** The page says the gadget is on screen and worth photographing. */
      @JavascriptInterface
      public void ready(String title, String actions) {
        main.post(() -> {
          Bitmap bmp = draw(web, width, height);
          once.on(new Result(bmp, title == null ? "" : title, actions == null ? "[]" : actions, null));
        });
      }

      /** The page cannot do it: no pairing, no computer, no such gadget. */
      @JavascriptInterface
      public void failed(String why) {
        main.post(() -> once.on(new Result(null, "", "[]", why == null || why.isEmpty() ? "Prism is not reachable" : why)));
      }
    }, "PrismWidgetHost");

    // laid out at the widget's own size, so what is drawn is what will be shown
    web.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
    web.layout(0, 0, width, height);

    web.loadUrl(WidgetAssets.pageFor(gadgetId, width, height, doCall).toString());

    giveUp[0] = () -> once.on(new Result(null, "", "[]", "Prism did not answer in time"));
    main.postDelayed(giveUp[0], PATIENCE_MS);
  }

  private static Bitmap draw(WebView web, int width, int height) {
    try {
      Bitmap bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
      Canvas canvas = new Canvas(bmp);
      web.draw(canvas);
      return bmp;
    } catch (Throwable t) {
      Log.e(TAG, "could not draw the page", t);
      return null;
    }
  }

}
