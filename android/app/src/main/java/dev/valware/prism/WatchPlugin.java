package dev.valware.prism;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * How the app's page starts and stops the background watcher (WatchService). It has to
 * be the app that starts it, while it is on screen: Android does not let an app begin
 * a foreground service from the background.
 */
@CapacitorPlugin(name = "Watch")
public class WatchPlugin extends Plugin {
  @PluginMethod
  public void start(PluginCall call) {
    try {
      WatchService.begin(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "Could not keep in touch in the background" : e.getMessage());
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    WatchService.end(getContext());
    call.resolve();
  }
}
