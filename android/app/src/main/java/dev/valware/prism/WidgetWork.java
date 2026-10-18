package dev.valware.prism;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.util.TypedValue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.TimeUnit;

/**
 * Keeps the pictures up to date: every so often, and whenever a widget is added,
 * resized or tapped. The work is short — open the page, draw, close — so nothing runs
 * in the background between refreshes and there is no notification to live with.
 */
public class WidgetWork extends Worker {
  private static final String PERIODIC = "prism-widgets-periodic";
  private static final String KEY_WIDGET = "widget";
  private static final String KEY_CALL = "call";
  /** Android will not run periodic work more often than this anyway. */
  private static final long EVERY_MINUTES = 15;

  public WidgetWork(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  /** One refresh now. A call runs the gadget's own handler first, then the picture is taken. */
  static void refresh(Context context, int widgetId, @Nullable String call) {
    Data data = new Data.Builder().putInt(KEY_WIDGET, widgetId).putString(KEY_CALL, call == null ? "" : call).build();
    WorkManager.getInstance(context).enqueue(new OneTimeWorkRequest.Builder(WidgetWork.class).setInputData(data).build());
  }

  /** From the first widget being added until the last is removed. */
  static void keepFresh(Context context) {
    PeriodicWorkRequest every = new PeriodicWorkRequest.Builder(WidgetWork.class, EVERY_MINUTES, TimeUnit.MINUTES)
        .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .build();
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, every);
  }

  static void stopKeepingFresh(Context context) {
    WorkManager.getInstance(context).cancelUniqueWork(PERIODIC);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    AppWidgetManager manager = AppWidgetManager.getInstance(context);
    int only = getInputData().getInt(KEY_WIDGET, AppWidgetManager.INVALID_APPWIDGET_ID);
    String call = getInputData().getString(KEY_CALL);
    if (call != null && call.isEmpty()) call = null;

    int[] ids = only != AppWidgetManager.INVALID_APPWIDGET_ID
        ? new int[] {only}
        : manager.getAppWidgetIds(new android.content.ComponentName(context, PrismWidget.class));

    for (int widgetId : ids) {
      String gadgetId = WidgetStore.gadget(context, widgetId);
      if (gadgetId == null) continue;
      int[] size = sizeOf(context, manager, widgetId);
      WidgetShot.Result shot = WidgetShot.take(context, gadgetId, size[0], size[1], call);
      if (shot.bitmap != null) {
        String path = write(context, widgetId, shot.bitmap);
        if (path != null) WidgetStore.setShown(context, widgetId, shot.title, shot.actions, path, System.currentTimeMillis());
        else WidgetStore.setProblem(context, widgetId, "The picture could not be saved");
      } else {
        WidgetStore.setProblem(context, widgetId, shot.problem == null ? "Prism is not reachable" : shot.problem);
      }
      PrismWidget.paint(context, manager, widgetId);
    }
    return Result.success();
  }

  /** The widget's size on the home screen, in real pixels. */
  private static int[] sizeOf(Context context, AppWidgetManager manager, int widgetId) {
    Bundle options = manager.getAppWidgetOptions(widgetId);
    int wDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
    int hDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
    if (wDp <= 0) wDp = 250;
    if (hDp <= 0) hDp = 150;
    Resources res = context.getResources();
    int w = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, wDp, res.getDisplayMetrics());
    int h = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, hDp, res.getDisplayMetrics());
    // a bitmap handed to the home screen has a size limit; well under it is also quicker
    int most = 1200;
    if (w > most) {
      h = h * most / w;
      w = most;
    }
    if (h > most) {
      w = w * most / h;
      h = most;
    }
    return new int[] {Math.max(160, w), Math.max(100, h)};
  }

  @Nullable
  private static String write(Context context, int widgetId, Bitmap bitmap) {
    File dir = new File(context.getFilesDir(), "widgets");
    if (!dir.exists() && !dir.mkdirs()) return null;
    // a new name each time, so the home screen does not show a cached old one
    File file = new File(dir, "w" + widgetId + "-" + System.currentTimeMillis() + ".png");
    try (FileOutputStream out = new FileOutputStream(file)) {
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
    } catch (Throwable t) {
      return null;
    }
    String old = WidgetStore.shot(context, widgetId);
    if (old != null && !old.equals(file.getAbsolutePath())) {
      File gone = new File(old);
      if (gone.exists()) {
        //noinspection ResultOfMethodCallIgnored
        gone.delete();
      }
    }
    return file.getAbsolutePath();
  }
}
