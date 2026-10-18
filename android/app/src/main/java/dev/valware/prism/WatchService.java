package dev.valware.prism;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import androidx.core.app.ServiceCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Keeps in touch with Prism when the app is closed, so it can still say "finished" or
 * "needs you" with the phone locked or the app swiped away.
 *
 * The app's own page lives in its window, and dies with it. This service opens the same
 * page in a web view of its own — no window, nothing on screen — which connects with
 * the same pairing and the same encrypted channel (src/renderer/src/remote/watch.ts).
 * Nothing is reimplemented here: this only keeps that page alive and turns what it says
 * into notifications.
 *
 * The notifications are meant to stand in for the app: a finished run carries its last
 * picture and a reply box, a file comes with a Save button, an approval comes with Allow
 * and Deny, and while a run is going there is a quiet "working" notification with Stop.
 * Every button lands back on the page, which sends it to the computer like any message.
 *
 * Android only lets an app stay connected like this as a foreground service, which has
 * to post a notification for as long as it runs. A notification that never goes away is clutter,
 * so it is posted to a channel that is switched off from the start: from Android 13
 * the service carries on and nothing shows (it is listed only under the active apps in
 * the quick settings). Older Android may show its own "running in the background" note
 * instead. It once said "Connecting…" and "Connected" in turn, every few minutes.
 */
public class WatchService extends Service {
  static final String PREFS = "prism-watch";
  static final String WANTED = "wanted";

  /**
   * A new id: Android keeps a channel's settings from when it was first made, so an older
   * channel cannot be changed. The old ones are deleted.
   */
  private static final String CH_STATUS = "watch-hidden";
  private static final String[] CH_STATUS_OLD = {"watch-status", "watch-quiet"};
  /** The only thing it ever says. */
  private static final String STILL = "Here so Prism can reach you while the app is closed";
  private static final String CH_NEWS = "watch-news";
  /** A run in progress: quiet, no sound, with a Stop button. */
  private static final String CH_WORK = "watch-work";
  /** A file handed over, with a Save button. */
  private static final String CH_FILES = "watch-files";
  private static final int STATUS_ID = 4401;

  /** Whether the app is on screen. Set by MainActivity; nothing is said while it is. */
  static volatile boolean appInFront = false;

  /** A tap on a question's button, or its reply box, comes back to the service as this. */
  private static final String ANSWER = "dev.valware.prism.ANSWER";
  /** A reply typed on a finished run's notification. */
  private static final String SEND = "dev.valware.prism.SEND";
  /** Allow or Deny on an approval's notification. */
  private static final String DECIDE = "dev.valware.prism.DECIDE";
  /** Stop on the "working" notification. */
  private static final String STOP = "dev.valware.prism.STOP";
  /** Save on a file's notification: fetch it to this phone. */
  private static final String FETCH = "dev.valware.prism.FETCH";
  private static final String REPLY = "reply";
  /** Each question's or approval's notification, so answering it anywhere can take it away. */
  private final Map<String, Integer> asked = new HashMap<>();
  /** A file on offer: its notification, and how to fetch it again when a download did not work. */
  private static class FileAsk {
    final int id;
    final String sessionId, itemId;
    FileAsk(int id, String sessionId, String itemId) {
      this.id = id;
      this.sessionId = sessionId;
      this.itemId = itemId;
    }
  }
  private final Map<String, FileAsk> fileAsks = new HashMap<>();
  /** Files whose download hit an error part-way, so "saved" is not said over a broken file. */
  private final Set<String> broken = new HashSet<>();

  private WebView web;
  private final Handler main = new Handler(Looper.getMainLooper());
  private int next = 5000;

  /** Starts it, and remembers that it is wanted, so it comes back after the phone restarts. */
  static void begin(Context context) {
    context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(WANTED, true).apply();
    Intent i = new Intent(context, WatchService.class);
    if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
    else context.startService(i);
  }

  static void end(Context context) {
    context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(WANTED, false).apply();
    context.stopService(new Intent(context, WatchService.class));
  }

  static boolean wanted(Context context) {
    SharedPreferences p = context.getSharedPreferences(PREFS, MODE_PRIVATE);
    return p.getBoolean(WANTED, false);
  }

  @Override
  public void onCreate() {
    super.onCreate();
    channels();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification n = status();
    if (Build.VERSION.SDK_INT >= 34) {
      ServiceCompat.startForeground(this, STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
    } else {
      startForeground(STATUS_ID, n);
    }
    if (web == null) open();
    if (intent != null && intent.getAction() != null) {
      String a = intent.getAction();
      if (ANSWER.equals(a)) answer(intent);
      else if (SEND.equals(a)) sent(intent);
      else if (DECIDE.equals(a)) decided(intent);
      else if (STOP.equals(a)) stopped(intent);
      else if (FETCH.equals(a)) fetch(intent);
    }
    // brought back by Android if it has to stop this to free memory
    return START_STICKY;
  }

  @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
  private void open() {
    final WebViewAssetLoader loader = WidgetAssets.loader(this);
    web = new WebView(getApplicationContext());
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
      public void say(String title, String body) {
        main.post(() -> news(title == null ? "Prism" : title, body == null ? "" : body));
      }

      @JavascriptInterface
      public void ask(String title, String body, String sessionId, String questionId, String optionsJson) {
        main.post(() -> question(title, body, sessionId, questionId, optionsJson));
      }

      @JavascriptInterface
      public void done(String questionId) {
        main.post(() -> forget(questionId));
      }

      /** Connection news is not shown: the notification stays as it is (see the class comment). */
      @JavascriptInterface
      public void status(String text) {
      }

      @JavascriptInterface
      public void finished(String title, String body, String sessionId, String imageJson) {
        main.post(() -> WatchService.this.finished(title, body, sessionId, imageJson));
      }

      @JavascriptInterface
      public void file(String sessionId, String itemId, String name, long size) {
        main.post(() -> fileNotice(sessionId, itemId, name, size));
      }

      @JavascriptInterface
      public void work(String sessionId, String title, boolean on) {
        main.post(() -> WatchService.this.work(sessionId, title, on));
      }

      @JavascriptInterface
      public void approve(String title, String body, String sessionId, String approvalId) {
        main.post(() -> approval(title, body, sessionId, approvalId));
      }

      /** A piece of a file the page is fetching: written to the cache, as the app's own file handler does. */
      @JavascriptInterface
      public void filePart(String name, String data, boolean first) {
        write(name, data, first);
      }

      @JavascriptInterface
      public void fileSaved(String name) {
        main.post(() -> saved(name));
      }

      @JavascriptInterface
      public void fileFailed(String name, String why) {
        main.post(() -> failed(name, why));
      }
    }, "PrismWatchHost");
    // the same address the app uses (http://localhost), so it shares the app's pairing
    web.loadUrl("http://localhost/index.html?watch=1");
  }

  private void channels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    for (String old : CH_STATUS_OLD) nm.deleteNotificationChannel(old);
    NotificationChannel quiet = new NotificationChannel(CH_STATUS, "Staying connected", NotificationManager.IMPORTANCE_NONE);
    quiet.setDescription("Lets Prism keep in touch while the app is closed. Off, so it does not show; turning it on only makes it visible.");
    quiet.setShowBadge(false);
    nm.createNotificationChannel(quiet);
    NotificationChannel loud = new NotificationChannel(CH_NEWS, "When Prism needs you", NotificationManager.IMPORTANCE_HIGH);
    loud.setDescription("A run has finished, or Prism is waiting for an answer, an approval or a decision.");
    nm.createNotificationChannel(loud);
    NotificationChannel work = new NotificationChannel(CH_WORK, "While Prism is working", NotificationManager.IMPORTANCE_LOW);
    work.setDescription("Shows while the agent works, quietly, with a Stop button.");
    work.setShowBadge(false);
    nm.createNotificationChannel(work);
    NotificationChannel files = new NotificationChannel(CH_FILES, "Files from a run", NotificationManager.IMPORTANCE_DEFAULT);
    files.setDescription("A file the agent handed over, with a button to save it to this phone.");
    nm.createNotificationChannel(files);
  }

  private PendingIntent openApp() {
    Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private Notification status() {
    return new NotificationCompat.Builder(this, CH_STATUS)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle("Prism")
        .setContentText(STILL)
        .setOngoing(true)
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(openApp())
        .build();
  }

  /** An id that belongs to one conversation, so its working notification can be replaced and cancelled. */
  private int workId(String sessionId) {
    return 5600 + Math.floorMod(sessionId == null ? 0 : sessionId.hashCode(), 300);
  }

  /** An id that belongs to one file, so its notification can become "saved" or "did not work". */
  private int fileId(String sessionId, String itemId) {
    return 6000 + Math.floorMod((sessionId + "/" + itemId).hashCode(), 300);
  }

  private String human(long bytes) {
    if (bytes >= 1024 * 1024 * 1024) return String.format("%.1f GB", bytes / 1073741824.0);
    if (bytes >= 1024 * 1024) return String.format("%.1f MB", bytes / 1048576.0);
    if (bytes >= 1024) return String.format("%.0f KB", bytes / 1024.0);
    return bytes + " B";
  }

  /** The picture a finished run ended with, from {"mime":...,"data":base64}, shrunk to what a notification can carry. */
  private Bitmap picture(String imageJson) {
    try {
      JSONObject o = new JSONObject(imageJson == null ? "" : imageJson);
      byte[] bytes = Base64.decode(o.optString("data", ""), Base64.DEFAULT);
      if (bytes.length == 0) return null;
      BitmapFactory.Options probe = new BitmapFactory.Options();
      probe.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, probe);
      BitmapFactory.Options read = new BitmapFactory.Options();
      read.inSampleSize = Math.max(1, Integer.highestOneBit(Math.max(1, probe.outWidth / 1440)));
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, read);
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * A question, answerable from the notification: up to three answers as buttons, and a
   * reply box for anything else when there is room (Android shows three actions at most).
   * More than three answers: the reply box alone, and tapping the notification opens the app.
   */
  private void question(String title, String body, String sessionId, String questionId, String optionsJson) {
    if (appInFront) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    int id = next++;
    if (next > 5500) next = 5000;
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_NEWS)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openApp());
    String[] options = new String[0];
    try {
      JSONArray a = new JSONArray(optionsJson == null ? "[]" : optionsJson);
      options = new String[a.length()];
      for (int i = 0; i < a.length(); i++) options[i] = a.getString(i);
    } catch (Exception ignored) {
    }
    if (options.length <= 3) {
      for (int i = 0; i < options.length; i++) {
        b.addAction(R.drawable.ic_stat_prism, options[i], answering(id * 10 + i, sessionId, questionId, options[i], false));
      }
    }
    if (options.length <= 2 || options.length > 3) {
      b.addAction(replyAction("Your answer", id * 10 + 9, sessionId, questionId));
    }
    nm.notify(id, b.build());
    asked.put(questionId, id);
  }

  private NotificationCompat.Action replyAction(String label, int code, String sessionId, String questionId) {
    RemoteInput box = new RemoteInput.Builder(REPLY).setLabel(label).build();
    return new NotificationCompat.Action.Builder(R.drawable.ic_stat_prism, "Reply", answering(code, sessionId, questionId, null, true))
        .addRemoteInput(box)
        .setAllowGeneratedReplies(false)
        .build();
  }

  /** A finished run: its answer, its last picture when it made one, and a reply box to answer it. */
  private void finished(String title, String body, String sessionId, String imageJson) {
    if (appInFront) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    int id = next++;
    if (next > 5500) next = 5000;
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_NEWS)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openApp());
    Bitmap pic = picture(imageJson);
    if (pic != null) b.setStyle(new NotificationCompat.BigPictureStyle().bigPicture(pic).setBigContentTitle(title));
    RemoteInput box = new RemoteInput.Builder(REPLY).setLabel("Reply to Prism").build();
    b.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_prism, "Reply", sending(id * 10 + 9, sessionId))
        .addRemoteInput(box)
        .setAllowGeneratedReplies(false)
        .build());
    nm.notify(id, b.build());
  }

  /** A run in progress: quiet and ongoing, with a Stop button. Ending it cancels the notification. */
  private void work(String sessionId, String title, boolean on) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null || sessionId == null) return;
    int id = workId(sessionId);
    if (!on) {
      nm.cancel(id);
      return;
    }
    if (appInFront) return;
    Notification n = new NotificationCompat.Builder(this, CH_WORK)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle("Prism is working")
        .setContentText(title == null || title.isEmpty() ? "A conversation with Prism" : title)
        .setOngoing(true)
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .addAction(R.drawable.ic_stat_prism, "Stop", stopping(sessionId))
        .setContentIntent(openApp())
        .build();
    nm.notify(id, n);
  }

  /** Something to allow or deny, answerable from the notification. */
  private void approval(String title, String body, String sessionId, String approvalId) {
    if (appInFront || sessionId == null || approvalId == null) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    int id = next++;
    if (next > 5500) next = 5000;
    Notification n = new NotificationCompat.Builder(this, CH_NEWS)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openApp())
        .addAction(R.drawable.ic_stat_prism, "Allow", deciding(sessionId, approvalId, "once", id * 10 + 1))
        .addAction(R.drawable.ic_stat_prism, "Deny", deciding(sessionId, approvalId, "deny", id * 10 + 2))
        .build();
    nm.notify(id, n);
    asked.put(approvalId, id);
  }

  /** A file handed over: a Save button that fetches it, then the notification becomes the saved file. */
  private void fileNotice(String sessionId, String itemId, String name, long size) {
    if (appInFront || sessionId == null || itemId == null || name == null) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    int id = fileId(sessionId, itemId);
    fileAsks.put(name, new FileAsk(id, sessionId, itemId));
    Notification n = new NotificationCompat.Builder(this, CH_FILES)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle("Prism has a file for you")
        .setContentText(size > 0 ? name + "  ·  " + human(size) : name)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setAutoCancel(false)
        .setContentIntent(openApp())
        .addAction(R.drawable.ic_stat_prism, "Save to phone", fetching(sessionId, itemId, name, id * 10 + 4))
        .build();
    nm.notify(id, n);
  }

  private PendingIntent answering(int code, String sessionId, String questionId, String label, boolean typed) {
    Intent i = new Intent(this, WatchService.class).setAction(ANSWER).putExtra("session", sessionId).putExtra("question", questionId);
    if (label != null) i.putExtra("label", label);
    // the reply box writes into the intent, so that one has to be changeable
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (typed ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE);
    return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, flags) : PendingIntent.getService(this, code, i, flags);
  }

  private PendingIntent sending(int code, String sessionId) {
    Intent i = new Intent(this, WatchService.class).setAction(SEND).putExtra("session", sessionId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
    return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, flags) : PendingIntent.getService(this, code, i, flags);
  }

  private PendingIntent deciding(String sessionId, String approvalId, String decision, int code) {
    Intent i = new Intent(this, WatchService.class).setAction(DECIDE)
        .putExtra("session", sessionId).putExtra("approval", approvalId).putExtra("decision", decision);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, flags) : PendingIntent.getService(this, code, i, flags);
  }

  private PendingIntent stopping(String sessionId) {
    Intent i = new Intent(this, WatchService.class).setAction(STOP).putExtra("session", sessionId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, sessionId.hashCode(), i, flags) : PendingIntent.getService(this, sessionId.hashCode(), i, flags);
  }

  private PendingIntent fetching(String sessionId, String itemId, String name, int code) {
    Intent i = new Intent(this, WatchService.class).setAction(FETCH)
        .putExtra("session", sessionId).putExtra("item", itemId).putExtra("name", name);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, flags) : PendingIntent.getService(this, code, i, flags);
  }

  /** Runs a line on the watcher page, which carries it to the computer. */
  private void page(String js) {
    if (web != null) web.evaluateJavascript(js, null);
  }

  /** A button tapped or a reply typed on a question's notification: the page sends it to Prism. */
  private void answer(Intent intent) {
    String sessionId = intent.getStringExtra("session");
    String questionId = intent.getStringExtra("question");
    String text = intent.getStringExtra("label");
    if (text == null) text = typed(intent);
    forget(questionId);
    if (sessionId == null || questionId == null || text == null || text.trim().isEmpty()) return;
    page("window.__prismAnswer && window.__prismAnswer(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(questionId) + "," + JSONObject.quote(text.trim()) + ")");
  }

  /** A reply typed on a finished run's notification: the page sends it as the next message. */
  private void sent(Intent intent) {
    String sessionId = intent.getStringExtra("session");
    String text = typed(intent);
    if (sessionId == null || text == null || text.trim().isEmpty()) return;
    page("window.__prismSend && window.__prismSend(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(text.trim()) + ")");
  }

  /** Allow or Deny on an approval's notification. */
  private void decided(Intent intent) {
    String sessionId = intent.getStringExtra("session");
    String approvalId = intent.getStringExtra("approval");
    String decision = intent.getStringExtra("decision");
    forget(approvalId);
    if (sessionId == null || approvalId == null || decision == null) return;
    page("window.__prismApprove && window.__prismApprove(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(approvalId) + "," + JSONObject.quote(decision) + ")");
  }

  /** Stop on the "working" notification. */
  private void stopped(Intent intent) {
    String sessionId = intent.getStringExtra("session");
    if (sessionId == null) return;
    page("window.__prismStop && window.__prismStop(" + JSONObject.quote(sessionId) + ")");
  }

  /** Save on a file's notification: the page fetches it and hands the pieces back. */
  private void fetch(Intent intent) {
    String sessionId = intent.getStringExtra("session");
    String itemId = intent.getStringExtra("item");
    String name = intent.getStringExtra("name");
    if (sessionId == null || itemId == null || name == null) return;
    FileAsk ask = fileAsks.get(name);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (ask != null && nm != null) {
      nm.notify(ask.id, new NotificationCompat.Builder(this, CH_FILES)
          .setSmallIcon(R.drawable.ic_stat_prism)
          .setContentTitle("Downloading " + name)
          .setContentText("From the computer to this phone")
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setProgress(0, 0, true)
          .build());
    }
    page("window.__prismFetchFile && window.__prismFetchFile(" + JSONObject.quote(sessionId) + "," + JSONObject.quote(itemId) + "," + JSONObject.quote(name) + ")");
  }

  /** What the reply box wrote into the intent, if anything. */
  private String typed(Intent intent) {
    Bundle typed = RemoteInput.getResultsFromIntent(intent);
    CharSequence t = typed == null ? null : typed.getCharSequence(REPLY);
    return t == null ? null : t.toString();
  }

  /** The question's or approval's notification goes: answered here, or somewhere else. */
  private void forget(String questionId) {
    Integer id = questionId == null ? null : asked.remove(questionId);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (id != null && nm != null) nm.cancel(id);
  }

  /** Where fetched files land, as the app's own file handler puts them. */
  private File fileFor(String name) {
    File dir = new File(getCacheDir(), "attachments");
    dir.mkdirs();
    // the name comes from the computer: only its last part, so it cannot point elsewhere
    return new File(dir, new File(name).getName());
  }

  /** One piece of a fetched file, written as it arrives; a bad piece is remembered so "saved" is not said over it. */
  private synchronized void write(String name, String data, boolean first) {
    try (FileOutputStream out = new FileOutputStream(fileFor(name), !first)) {
      out.write(Base64.decode(data == null ? "" : data, Base64.DEFAULT));
    } catch (Exception e) {
      broken.add(name);
    }
  }

  /** The file is on the phone: the notification becomes it, and tapping opens it. */
  private void saved(String name) {
    if (name == null) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    FileAsk ask = fileAsks.remove(name);
    if (nm == null) return;
    if (broken.remove(name)) {
      failed(name, "It did not arrive whole. Try again with the computer in reach.");
      return;
    }
    File f = fileFor(name);
    if (!f.isFile()) {
      failed(name, "It did not arrive. Try again with the computer in reach.");
      return;
    }
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_FILES)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle("Saved " + name)
        .setContentText("Tap to open it")
        .setAutoCancel(true)
        .setContentIntent(opening(f));
    if (ask != null) nm.notify(ask.id, b.build());
    else {
      nm.notify(next++, b.build());
      if (next > 5500) next = 5000;
    }
  }

  /** The file could not be fetched after all: Save stays, for another try. */
  private void failed(String name, String why) {
    if (name == null) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    FileAsk ask = fileAsks.get(name);
    if (nm == null) return;
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_FILES)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle(name + " did not come through")
        .setContentText(why == null || why.isEmpty() ? "It could not be fetched." : why)
        .setAutoCancel(true)
        .setContentIntent(openApp());
    if (ask != null) b.addAction(R.drawable.ic_stat_prism, "Try again", fetching(ask.sessionId, ask.itemId, name, ask.id * 10 + 4));
    if (ask != null) nm.notify(ask.id, b.build());
    else {
      nm.notify(next++, b.build());
      if (next > 5500) next = 5000;
    }
  }

  /** Opens a fetched file with whatever opens that kind — for an APK, the installer. */
  private PendingIntent opening(File f) {
    String n = f.getName();
    String ext = n.lastIndexOf('.') < 0 ? "" : n.substring(n.lastIndexOf('.') + 1).toLowerCase();
    String mime = "apk".equals(ext) ? "application/vnd.android.package-archive" : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    if (mime == null) mime = "*/*";
    Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f);
    Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    // nothing on this phone opens it: tapping the notification at least opens the app
    if (getPackageManager().queryIntentActivities(view, 0).isEmpty()) return openApp();
    return PendingIntent.getActivity(this, n.hashCode(), view, PendingIntent.FLAG_IMMUTABLE);
  }

  /** Something worth knowing — unless Prism is the app in front, where it is already on screen. */
  private void news(String title, String body) {
    if (appInFront) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    Notification n = new NotificationCompat.Builder(this, CH_NEWS)
        .setSmallIcon(R.drawable.ic_stat_prism)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openApp())
        .build();
    nm.notify(next++, n);
    if (next > 5500) next = 5000;
  }

  @Override
  public void onDestroy() {
    if (web != null) {
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
