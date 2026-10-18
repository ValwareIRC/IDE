package dev.valware.prism;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.Nullable;

import java.io.File;

/** What each widget on the home screen is showing, kept between refreshes. */
final class WidgetStore {
  private static final String FILE = "prism-widgets";

  private WidgetStore() {}

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  static void setGadget(Context context, int widgetId, String gadgetId) {
    prefs(context).edit().putString(widgetId + ".gadget", gadgetId).apply();
  }

  @Nullable
  static String gadget(Context context, int widgetId) {
    return prefs(context).getString(widgetId + ".gadget", null);
  }

  static void setShown(Context context, int widgetId, String title, String actions, String shotPath, long when) {
    prefs(context)
        .edit()
        .putString(widgetId + ".title", title)
        .putString(widgetId + ".actions", actions)
        .putString(widgetId + ".shot", shotPath)
        .putLong(widgetId + ".when", when)
        .remove(widgetId + ".problem")
        .apply();
  }

  static void setProblem(Context context, int widgetId, String problem) {
    prefs(context).edit().putString(widgetId + ".problem", problem).apply();
  }

  static String title(Context context, int widgetId) {
    return prefs(context).getString(widgetId + ".title", "");
  }

  static String actions(Context context, int widgetId) {
    return prefs(context).getString(widgetId + ".actions", "[]");
  }

  @Nullable
  static String shot(Context context, int widgetId) {
    return prefs(context).getString(widgetId + ".shot", null);
  }

  static long when(Context context, int widgetId) {
    return prefs(context).getLong(widgetId + ".when", 0);
  }

  @Nullable
  static String problem(Context context, int widgetId) {
    return prefs(context).getString(widgetId + ".problem", null);
  }

  /** The widget is gone from the home screen: forget it, and its picture. */
  static void forget(Context context, int widgetId) {
    String shot = shot(context, widgetId);
    if (shot != null) {
      File f = new File(shot);
      if (f.exists()) {
        // best effort: a leftover picture is harmless
        //noinspection ResultOfMethodCallIgnored
        f.delete();
      }
    }
    prefs(context)
        .edit()
        .remove(widgetId + ".gadget")
        .remove(widgetId + ".title")
        .remove(widgetId + ".actions")
        .remove(widgetId + ".shot")
        .remove(widgetId + ".when")
        .remove(widgetId + ".problem")
        .apply();
  }
}
