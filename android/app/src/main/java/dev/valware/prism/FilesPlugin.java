package dev.valware.prism;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Files the agent hands over, fetched from the computer a piece at a time and opened here
 * with whatever opens that kind of file - for an APK, the installer. They are kept in the
 * app's cache, which Android clears when it needs the room.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
  private File fileFor(String name) {
    File dir = new File(getContext().getCacheDir(), "attachments");
    dir.mkdirs();
    // the name comes from the computer: only its last part, so it cannot point elsewhere
    return new File(dir, new File(name).getName());
  }

  @PluginMethod
  public void save(PluginCall call) {
    String name = call.getString("name", "");
    String data = call.getString("data", "");
    boolean append = Boolean.TRUE.equals(call.getBoolean("append", false));
    if (name.isEmpty()) {
      call.reject("No file name");
      return;
    }
    try (FileOutputStream out = new FileOutputStream(fileFor(name), append)) {
      out.write(Base64.decode(data, Base64.DEFAULT));
      call.resolve();
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "Could not save the file" : e.getMessage());
    }
  }

  @PluginMethod
  public void open(PluginCall call) {
    File f = fileFor(call.getString("name", ""));
    if (!f.isFile()) {
      call.reject("The file has not been fetched yet");
      return;
    }
    String n = f.getName();
    String ext = n.lastIndexOf('.') < 0 ? "" : n.substring(n.lastIndexOf('.') + 1).toLowerCase();
    String mime = "apk".equals(ext) ? "application/vnd.android.package-archive" : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    if (mime == null) mime = "*/*";
    Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
    Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      getActivity().startActivity(view);
      call.resolve();
    } catch (ActivityNotFoundException e) {
      call.reject("Nothing on this phone opens ." + ext + " files");
    }
  }
}
