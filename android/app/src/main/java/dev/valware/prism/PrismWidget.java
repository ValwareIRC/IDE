package dev.valware.prism;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Date;

/**
 * A gadget on the home screen. The picture is taken by WidgetWork, which asks the
 * app's own page to draw the gadget; this class only arranges what is already known,
 * and asks for a fresh picture when the home screen or a tap calls for one.
 */
public class PrismWidget extends AppWidgetProvider {
  static final String ACTION_TAP = "dev.valware.prism.WIDGET_TAP";
  static final String ACTION_REFRESH = "dev.valware.prism.WIDGET_REFRESH";
  static final String EXTRA_ACTION_INDEX = "index";

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
    for (int id : widgetIds) {
      paint(context, manager, id);
      WidgetWork.refresh(context, id, null);
    }
  }

  @Override
  public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int widgetId, Bundle newOptions) {
    // resized: the old picture is the wrong shape, so take another
    paint(context, manager, widgetId);
    WidgetWork.refresh(context, widgetId, null);
  }

  @Override
  public void onDeleted(Context context, int[] widgetIds) {
    for (int id : widgetIds) WidgetStore.forget(context, id);
  }

  @Override
  public void onEnabled(Context context) {
    WidgetWork.keepFresh(context);
  }

  @Override
  public void onDisabled(Context context) {
    WidgetWork.stopKeepingFresh(context);
  }

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent.getAction();
    if (ACTION_TAP.equals(action) || ACTION_REFRESH.equals(action)) {
      int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
      if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return;
      String call = null;
      if (ACTION_TAP.equals(action)) {
        int index = intent.getIntExtra(EXTRA_ACTION_INDEX, -1);
        call = callAt(WidgetStore.actions(context, widgetId), index);
        if (call == null) return;
      }
      WidgetWork.refresh(context, widgetId, call);
      return;
    }
    super.onReceive(context, intent);
  }

  /** The handler behind one of the gadget's declared buttons. */
  @Nullable
  private static String callAt(String actionsJson, int index) {
    try {
      JSONArray arr = new JSONArray(actionsJson);
      if (index < 0 || index >= arr.length()) return null;
      JSONObject o = arr.getJSONObject(index);
      String call = o.optString("call", "");
      return call.isEmpty() ? null : call;
    } catch (Throwable t) {
      return null;
    }
  }

  /** Puts what is known about this widget on the home screen. */
  static void paint(Context context, AppWidgetManager manager, int widgetId) {
    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.prism_widget);
    String gadgetId = WidgetStore.gadget(context, widgetId);
    String title = WidgetStore.title(context, widgetId);
    views.setTextViewText(R.id.widget_title, title.isEmpty() ? (gadgetId == null ? context.getString(R.string.app_name) : gadgetId) : title);

    String problem = WidgetStore.problem(context, widgetId);
    String shot = WidgetStore.shot(context, widgetId);
    long when = WidgetStore.when(context, widgetId);

    if (problem != null) {
      // she asked for this to be said plainly rather than quietly showing a stale picture
      views.setViewVisibility(R.id.widget_shot, View.GONE);
      views.setViewVisibility(R.id.widget_problem, View.VISIBLE);
      views.setTextViewText(R.id.widget_problem, problem);
      views.setTextViewText(R.id.widget_when, when > 0 ? "last " + clock(context, when) : "");
    } else {
      views.setViewVisibility(R.id.widget_problem, View.GONE);
      views.setViewVisibility(R.id.widget_shot, View.VISIBLE);
      if (shot != null && new File(shot).exists()) {
        views.setImageViewBitmap(R.id.widget_shot, BitmapFactory.decodeFile(shot));
      }
      views.setTextViewText(R.id.widget_when, when > 0 ? clock(context, when) : context.getString(R.string.widget_loading));
    }

    // the picture opens the gadget in the app
    Intent open = new Intent(context, MainActivity.class);
    open.setAction(Intent.ACTION_MAIN);
    if (gadgetId != null) open.putExtra("gadget", gadgetId);
    open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    views.setOnClickPendingIntent(R.id.widget_shot, PendingIntent.getActivity(context, widgetId, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    views.setOnClickPendingIntent(R.id.widget_title, tap(context, widgetId, ACTION_REFRESH, -1));

    int[] buttons = {R.id.widget_action_0, R.id.widget_action_1, R.id.widget_action_2};
    int shown = 0;
    try {
      JSONArray arr = new JSONArray(WidgetStore.actions(context, widgetId));
      for (int i = 0; i < buttons.length; i++) {
        if (i < arr.length()) {
          JSONObject o = arr.getJSONObject(i);
          String label = o.optString("label", "");
          if (!label.isEmpty()) {
            views.setViewVisibility(buttons[i], View.VISIBLE);
            views.setTextViewText(buttons[i], label);
            views.setOnClickPendingIntent(buttons[i], tap(context, widgetId, ACTION_TAP, i));
            shown++;
            continue;
          }
        }
        views.setViewVisibility(buttons[i], View.GONE);
      }
    } catch (Throwable t) {
      for (int b : buttons) views.setViewVisibility(b, View.GONE);
    }
    views.setViewVisibility(R.id.widget_actions, shown > 0 ? View.VISIBLE : View.GONE);

    manager.updateAppWidget(widgetId, views);
  }

  static void paintAll(Context context) {
    AppWidgetManager manager = AppWidgetManager.getInstance(context);
    for (int id : manager.getAppWidgetIds(new ComponentName(context, PrismWidget.class))) paint(context, manager, id);
  }

  private static PendingIntent tap(Context context, int widgetId, String action, int index) {
    Intent intent = new Intent(context, PrismWidget.class);
    intent.setAction(action);
    intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
    intent.putExtra(EXTRA_ACTION_INDEX, index);
    // every button needs a request code of its own or they all do the same thing
    int code = widgetId * 10 + (index + 2);
    return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static String clock(Context context, long when) {
    return DateFormat.getTimeFormat(context).format(new Date(when));
  }
}
