package dev.valware.prism;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // a plugin of the app's own, so the page can start the background watcher
    registerPlugin(WatchPlugin.class);
    // and one that saves and opens the files the agent hands over
    registerPlugin(FilesPlugin.class);
    super.onCreate(savedInstanceState);
  }

  // The background watcher stays quiet while the app is on screen: what it would say is
  // already in front of you.
  @Override
  public void onResume() {
    super.onResume();
    WatchService.appInFront = true;
  }

  @Override
  public void onPause() {
    WatchService.appInFront = false;
    super.onPause();
  }
}
