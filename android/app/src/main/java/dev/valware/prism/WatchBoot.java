package dev.valware.prism;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The phone has restarted: the background watcher comes back too, if it was running
 * before — so a restart is not a silent end to being told when Prism needs you.
 */
public class WatchBoot extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String a = intent == null ? null : intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
    if (!WatchService.wanted(context)) return;
    try {
      WatchService.begin(context);
    } catch (Exception ignored) {
      // Android may refuse a service started this early; the app starts it when next opened
    }
  }
}
