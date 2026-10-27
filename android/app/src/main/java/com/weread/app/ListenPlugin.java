package com.weread.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for 听书's OS presence: the foreground service and its notification.
 *
 * The page calls `start` when listening begins, `update` as it moves between
 * sentences / pauses, and `stop` when the session closes. The service's two
 * buttons come back the other way as `onToggle` / `onStop` listeners, so the
 * sentence loop keeps owning pause semantics rather than a second, native copy
 * of the state machine.
 *
 * Failure is never fatal: without the notification permission, or on an OEM
 * build that refuses foreground promotion, the page still speaks — it just does
 * not survive being backgrounded for long.
 */
@CapacitorPlugin(name = "Listen")
public class ListenPlugin extends Plugin {

    private static final int REQ_NOTIFICATIONS = 0x51D0;

    @Override
    public void load() {
        ListenService.bind(new ListenService.Callback() {
            @Override
            public void onToggle() {
                notifyListeners("onToggle", new JSObject(), true);
            }

            @Override
            public void onStop() {
                notifyListeners("onStop", new JSObject(), true);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        ListenService.unbind();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        ensureNotificationPermission();
        ListenService.start(
                context(),
                call.getString("title", ""),
                call.getString("text", ""),
                Boolean.TRUE.equals(call.getBoolean("playing", true)));
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        ListenService.update(
                context(),
                call.getString("title", ""),
                call.getString("text", ""),
                Boolean.TRUE.equals(call.getBoolean("playing", true)));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ListenService.stop(context());
        call.resolve();
    }

    private Context context() {
        return getContext();
    }

    /**
     * Android 13+ suppresses every notification — including a foreground
     * service's — until POST_NOTIFICATIONS is granted. Ask once, the first time
     * the user actually starts listening, instead of at launch.
     */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (getActivity() == null) return;
        if (ActivityCompat.checkSelfPermission(getActivity(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
                getActivity(),
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQ_NOTIFICATIONS);
    }
}
