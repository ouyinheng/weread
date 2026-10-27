package com.weread.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that keeps 听书 alive when the app is not on screen.
 *
 * The sentence loop itself still runs in the WebView: the TTS plugins queue one
 * utterance at a time and report completion back to JS. What that loop lacks is
 * *permission to keep running* — Android freezes or kills a cached process
 * within seconds, and JS timers in a backgrounded WebView are throttled. A
 * media-playback foreground service changes both: the process stays alive and
 * gets scheduled normally, exactly like a music player.
 *
 * Design choices that matter:
 *
 *  - **The service never speaks.** It owns no audio state beyond what the page
 *    told it (title / line / playing), so there is one source of truth and no
 *    chance of the notification and the voice disagreeing.
 *  - **It stops when the task is swiped away.** `stopWithTask="false"` keeps the
 *    process alive across a mere 返回 (that is the whole point), but a removed
 *    task means the user asked for silence — `onTaskRemoved` shuts it down.
 *  - **Notification buttons are routed back to JS** (`onToggle` / `onStop`) so
 *    pause keeps its "stop the engine and remember the sentence" semantics.
 */
public class ListenService extends Service {

    public static final String ACTION_START = "com.weread.app.LISTEN_START";
    public static final String ACTION_UPDATE = "com.weread.app.LISTEN_UPDATE";
    /** From the notification: close the session (JS decides what that means). */
    public static final String ACTION_STOP = "com.weread.app.LISTEN_STOP";
    /** From the page: the session is already closed, just tear the service down. */
    public static final String ACTION_CLOSE = "com.weread.app.LISTEN_CLOSE";
    public static final String ACTION_TOGGLE = "com.weread.app.LISTEN_TOGGLE";

    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_TEXT = "text";
    private static final String EXTRA_PLAYING = "playing";

    private static final String CHANNEL_ID = "listen";
    private static final int NOTIFICATION_ID = 0x1D10;

    /** Where notification buttons go. Set by {@link ListenPlugin}. */
    interface Callback {
        void onToggle();
        void onStop();
    }

    private static volatile Callback callback;

    static void bind(Callback cb) {
        callback = cb;
    }

    static void unbind() {
        callback = null;
    }

    private String title = "";
    private String text = "";
    private boolean playing = false;
    private boolean foreground = false;

    /* ---------------- entry points from the page ---------------- */

    static void start(Context context, String title, String text, boolean playing) {
        deliver(context, ACTION_START, title, text, playing);
    }

    static void update(Context context, String title, String text, boolean playing) {
        deliver(context, ACTION_UPDATE, title, text, playing);
    }

    static void stop(Context context) {
        // ACTION_CLOSE, not ACTION_STOP: the page has already closed the
        // session, so echoing onStop back would bounce stop() ↔ service forever.
        Intent intent = new Intent(context, ListenService.class).setAction(ACTION_CLOSE);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception e) {
            try {
                context.stopService(new Intent(context, ListenService.class));
            } catch (Exception ignored) { /* nothing to stop */ }
        }
    }

    private static void deliver(Context context, String action, String title, String text, boolean playing) {
        Intent intent = new Intent(context, ListenService.class)
                .setAction(action)
                .putExtra(EXTRA_TITLE, title == null ? "" : title)
                .putExtra(EXTRA_TEXT, text == null ? "" : text)
                .putExtra(EXTRA_PLAYING, playing);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException on Android 12+ when the
            // app is already in the background. Playback continues; the user
            // simply keeps the notification that is already showing.
        }
    }

    /* ---------------- service lifecycle ---------------- */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_CLOSE.equals(action)) {
            teardown();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            // The notification's 关闭 button: let the page close the session so
            // progress is written and the mini control disappears.
            Callback cb = callback;
            if (cb != null) cb.onStop();
            teardown();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(action)) {
            Callback cb = callback;
            if (cb != null) cb.onToggle();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String t = intent.getStringExtra(EXTRA_TITLE);
            String s = intent.getStringExtra(EXTRA_TEXT);
            if (t != null) title = t;
            if (s != null) text = s;
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
        }

        ensureChannel();
        if (!foreground) {
            // Must happen within a few seconds of startForegroundService().
            startInForeground();
        } else {
            notifyUpdate();
        }
        // START_NOT_STICKY: a restarted service would show a notification for
        // playback that no longer exists.
        return START_NOT_STICKY;
    }

    private void startInForeground() {
        Notification n = build(true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID,
                        n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
        } catch (Exception e) {
            // Missing permission / refused promotion: playback still works in
            // the foreground, so this must not crash the service.
            foreground = false;
        }
    }

    private void notifyUpdate() {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            nm.notify(NOTIFICATION_ID, build(false));
        } catch (Exception e) {
            // Notification denied by the user — nothing to do.
        }
    }

    /** Leave no notification behind and stop owning the process. */
    private void teardown() {
        foreground = false;
        try {
            stopForeground(true);
        } catch (Exception ignored) { /* already gone */ }
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        /*
         * 从最近任务里划掉 = 用户要求停下来。Activity 连同 WebView 一起没了，
         * 朗读队列的后续句子本来也发不出去；这里再把通知清掉、服务退出，
         * 引擎由插件的 handleOnDestroy 一并 shutdown。
         */
        callback = null;
        teardown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        foreground = false;
        try {
            stopForeground(true);
        } catch (Exception ignored) { /* already gone */ }
        super.onDestroy();
    }

    /* ---------------- notification ---------------- */

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.listen_channel_name),
                // LOW: 听书 is a status, not an alert — no sound, no heads-up.
                NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(getString(R.string.listen_channel_desc));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification build(boolean starting) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_listen)
                .setContentTitle(title.isEmpty() ? getString(R.string.listen_fallback_title) : title)
                .setContentText(text.isEmpty()
                        ? getString(R.string.listen_fallback_text)
                        : text)
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        Intent open = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
                this, 1, open, pendingFlags());
        b.setContentIntent(openPi);

        PendingIntent toggle = PendingIntent.getService(
                this, 2,
                new Intent(this, ListenService.class).setAction(ACTION_TOGGLE),
                pendingFlags());
        b.addAction(0,
                getString(playing ? R.string.listen_action_pause : R.string.listen_action_play),
                toggle);

        PendingIntent close = PendingIntent.getService(
                this, 3,
                new Intent(this, ListenService.class).setAction(ACTION_STOP),
                pendingFlags());
        b.addAction(0, getString(R.string.listen_action_close), close);

        if (starting) {
            // A foreground service must show something immediately; from the
            // first frame it is the real state, not a placeholder.
            b.setSubText(getString(R.string.listen_notice));
        }
        return b.build();
    }

    private int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }
}
