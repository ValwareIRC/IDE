package dev.valware.prism;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Which gadget this widget should show. Asked once, when the widget is added. The list
 * comes from the computer through the app's own page, so this waits a moment while the
 * page connects.
 */
public class WidgetPickActivity extends Activity {
  private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
  private LinearLayout list;
  private TextView status;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    // backing out without choosing leaves no widget, which is what Android expects
    setResult(RESULT_CANCELED);
    Bundle extras = getIntent().getExtras();
    if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish();
      return;
    }

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.parseColor("#07080C"));
    root.setPadding(pad(20), pad(28), pad(20), pad(20));

    TextView head = new TextView(this);
    head.setText(R.string.widget_pick);
    head.setTextColor(Color.parseColor("#E9ECF4"));
    head.setTextSize(20);
    root.addView(head);

    status = new TextView(this);
    status.setText(R.string.widget_loading);
    status.setTextColor(Color.parseColor("#6D7489"));
    status.setPadding(0, pad(10), 0, pad(10));
    root.addView(status);

    ScrollView scroll = new ScrollView(this);
    list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(list);
    root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

    setContentView(root);
    ask();
  }

  /** The page is asked for the gadget list the same way the picture is taken. */
  private void ask() {
    new Thread(() -> {
      final String gadgets = WidgetList.fetch(this);
      new Handler(Looper.getMainLooper()).post(() -> show(gadgets));
    }).start();
  }

  private void show(String gadgetsJson) {
    list.removeAllViews();
    JSONArray arr;
    try {
      arr = new JSONArray(gadgetsJson == null ? "[]" : gadgetsJson);
    } catch (Throwable t) {
      arr = new JSONArray();
    }
    if (arr.length() == 0) {
      status.setText(R.string.widget_none);
      return;
    }
    status.setVisibility(View.GONE);
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o == null) continue;
      final String id = o.optString("id", "");
      String name = o.optString("name", id);
      if (id.isEmpty()) continue;
      Button b = new Button(this);
      b.setText(name);
      b.setAllCaps(false);
      b.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
      b.setTextColor(Color.parseColor("#E9ECF4"));
      b.setBackgroundResource(R.drawable.prism_widget_btn);
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      lp.bottomMargin = pad(8);
      b.setLayoutParams(lp);
      b.setOnClickListener(v -> choose(id));
      list.addView(b);
    }
  }

  private void choose(String gadgetId) {
    WidgetStore.setGadget(this, widgetId, gadgetId);
    PrismWidget.paint(this, AppWidgetManager.getInstance(this), widgetId);
    WidgetWork.keepFresh(this);
    WidgetWork.refresh(this, widgetId, null);
    Intent result = new Intent();
    result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
    setResult(RESULT_OK, result);
    finish();
  }

  private int pad(int dp) {
    return (int) (dp * getResources().getDisplayMetrics().density);
  }
}
