package com.weread.app;

import android.content.ContentValues;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Hosts the Capacitor WebView.
 *
 * The web layer owns every colour decision (it knows the current reader theme),
 * so this activity only mirrors them onto the Android chrome that the page
 * cannot paint itself:
 *
 *  - system bars are transparent, so the page background shows through instead
 *    of a white strip above and below the content
 *  - the navigation-bar contrast scrim is cleared, otherwise gesture nav draws
 *    a grey band under the tab bar
 *  - bar icon colours follow the page's light/dark state, and the page is told
 *    how tall each bar is so its own chrome can stay clear of them
 *
 * Edge-to-edge is requested explicitly (`setDecorFitsSystemWindows(false)`)
 * rather than left to the platform: since Android 15 it is forced for apps
 * targeting SDK 35+, so a build that assumed the old inset window would clip
 * the header under the clock on newer devices while looking fine on older
 * ones. With the window edge-to-edge everywhere, these insets are the single
 * source of truth and the page pads itself by exactly that much.
 */
public class MainActivity extends BridgeActivity {

    /** Cached insets in dp; refreshed whenever the window is laid out again. */
    private volatile double insetTopDp = 0;
    private volatile double insetBottomDp = 0;

    /**
     * 音量键翻页 is a setting the page owns, but volume keys never reach a
     * WebView: the Activity has to consume them and forward a direction. The
     * flag is flipped by the bridge while the reader is on screen.
     */
    private volatile boolean volumeKeysEnabled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins, registered before the bridge boots — they are not npm
        // packages, so nothing generates a capacitor.plugins.json entry for them.
        registerPlugin(TtsPlugin.class);
        registerPlugin(EdgeTtsPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBars();
        exposeBarBridge();
    }

    private void applySystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarDividerColor(Color.TRANSPARENT);
        /*
         * Android 10+ paints a translucent contrast scrim behind the system
         * bars. On a dark tab bar it shows up as a lighter grey strip under the
         * page, breaking the bar colour. The page already owns the background,
         * so turn the scrim off and let it show through.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        // Bootstrap from resources so the very first frame is already inset
        // correctly; the window-inset read refines it right after layout.
        insetTopDp = resourceDp("status_bar_height");
        insetBottomDp = 0;
    }

    private double resourceDp(String name) {
        int id = getResources().getIdentifier(name, "dimen", "android");
        if (id <= 0) return 0;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) return 0;
        return round1(getResources().getDimensionPixelSize(id) / density);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) captureInsets();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        captureInsets();
    }

    /**
     * Volume keys drive page turns while the reader asks for it.
     *
     * The WebView never receives them (the system owns volume by default), so
     * this is the only place the app can act on them. Both key-down and key-up
     * are consumed, otherwise the volume panel still pops up on top of the page.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (volumeKeysEnabled) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (event.getAction() == KeyEvent.ACTION_DOWN) {
                    final String dir = code == KeyEvent.KEYCODE_VOLUME_UP ? "prev" : "next";
                    WebView wv = getBridge() == null ? null : getBridge().getWebView();
                    if (wv != null) {
                        wv.post(() -> wv.evaluateJavascript(
                                "window.__readerVolumeTurn&&window.__readerVolumeTurn('" + dir + "')",
                                null));
                    }
                }
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /** Read the real window insets — the authoritative values on every API level. */
    private void captureInsets() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
        if (insets == null) return;
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) return;

        Insets sb = insets.getInsets(WindowInsetsCompat.Type.statusBars());
        Insets nb = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
        insetTopDp = round1(sb.top / density);
        insetBottomDp = round1(nb.bottom / density);
    }

    private double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    /** Let the page flip bar icon colours when the reader theme changes. */
    private void exposeBarBridge() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.addJavascriptInterface(new SystemBarsBridge(), "AndroidSystemBars");
    }

    public class SystemBarsBridge {

        /**
         * Backup sink. The zip is streamed from JS in chunks and written here,
         * because a WebView's `<a download>` goes nowhere the user can find and
         * `navigator.share` is not guaranteed on Android WebView.
         */
        private OutputStream backupStream = null;
        private Uri backupUri = null;
        private String backupPath = "";

        /** @param light true when the page background is light (dark icons). */
        @JavascriptInterface
        public void setLight(final boolean light) {
            runOnUiThread(() -> {
                WindowInsetsControllerCompat c =
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                c.setAppearanceLightStatusBars(light);
                c.setAppearanceLightNavigationBars(light);
            });
        }

        /**
         * System-bar insets in CSS px (dp), as JSON.
         *
         * Either edge reads 0 when its bar does not occupy space (gesture
         * navigation, hidden status bar), which is exactly what CSS should pad
         * by — so 0 is a meaningful answer, not a failure.
         */
        @JavascriptInterface
        public String getInsets() {
            if (insetTopDp <= 0) {
                double probe = resourceDp("status_bar_height");
                if (probe > 0) insetTopDp = probe;
            }
            return "{\"top\":" + insetTopDp + ",\"bottom\":" + insetBottomDp + "}";
        }

        /**
         * The device font-size multiplier from Settings → Display → Font size.
         *
         * Native UI grows with it (sp); WebView text does not, so the page
         * multiplies its chrome typography by it to stay in step.
         */
        @JavascriptInterface
        public double getFontScale() {
            return getResources().getConfiguration().fontScale;
        }

        /** 阅读时不自动锁屏 */
        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /**
         * 阅读时允许横屏. Off pins the activity to portrait for the reader;
         * on returns orientation to the system. Restored on leaving the reader.
         */
        @JavascriptInterface
        public void setLandscapeAllowed(final boolean allowed) {
            runOnUiThread(() -> setRequestedOrientation(
                    allowed
                            ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                            : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        }

        /** 音量键翻页 — see dispatchKeyEvent. */
        @JavascriptInterface
        public void setVolumeKeys(final boolean on) {
            volumeKeysEnabled = on;
        }

        /* ---------------- 备份导出 ---------------- */

        /**
         * Open a file for writing. Returns the user-facing path, or an empty
         * string when the write cannot be started.
         *
         * API 29+ goes into the public 下载 collection through MediaStore (no
         * permission needed); older releases fall back to the app's own external
         * Download folder, which also needs no runtime permission.
         */
        @JavascriptInterface
        public String beginFile(String fileName, String mimeType) {
            closeBackup(false);
            backupPath = "";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return "";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) {
                        getContentResolver().delete(uri, null, null);
                        return "";
                    }
                    backupUri = uri;
                    backupStream = new BufferedOutputStream(os);
                    backupPath = "下载/" + fileName;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists() && !dir.mkdirs()) return "";
                    File f = new File(dir, fileName);
                    backupStream = new BufferedOutputStream(new FileOutputStream(f));
                    backupPath = f.getAbsolutePath();
                }
                return backupPath;
            } catch (Exception e) {
                closeBackup(false);
                return "";
            }
        }

        /** Append one base64 chunk. Chunking keeps a 100 MB library off the bridge heap. */
        @JavascriptInterface
        public boolean appendFile(String base64Chunk) {
            if (backupStream == null) return false;
            try {
                backupStream.write(Base64.decode(base64Chunk, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** Finish the stream; on failure the partial file is removed. */
        @JavascriptInterface
        public String endFile(boolean success) {
            String path = backupPath;
            closeBackup(success);
            return success ? path : "";
        }

        private void closeBackup(boolean keep) {
            if (backupStream != null) {
                try {
                    backupStream.flush();
                    backupStream.close();
                } catch (Exception ignored) { /* best effort */ }
                backupStream = null;
            }
            if (!keep && backupUri != null) {
                try {
                    getContentResolver().delete(backupUri, null, null);
                } catch (Exception ignored) { /* file may not exist */ }
            }
            backupUri = null;
        }
    }
}
