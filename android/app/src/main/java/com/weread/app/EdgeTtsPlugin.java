package com.weread.app;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Server-side Chinese voices with emotion, using the same public endpoint the
 * Edge browser's read-aloud uses.
 *
 * Why a network engine at all: the phone's built-in TTS voices are flat. The
 * narration styles exposed here (`narration-relaxed`, `narration-professional`,
 * `gentle`, …) actually act the sentence, which is what makes 番茄's listening
 * mode sound human. Everything is still spoken through the same event contract
 * as {@link TtsPlugin}, so the JS player does not care which engine ran.
 *
 * One sentence per WebSocket: the endpoint takes SSML, streams MP3 frames back
 * and ends the turn with `Path:turn.end`. The plugin buffers those frames,
 * writes one temp file per sentence and hands it to MediaPlayer. A sentence
 * lives for a few seconds, so the extra handshake is cheaper than keeping a
 * socket alive through pauses and chapter jumps.
 *
 * Failure is deliberately noisy: if the network is down the JS layer switches
 * to the system voice or shows an error, rather than pretending to play.
 */
@CapacitorPlugin(name = "EdgeTts")
public class EdgeTtsPlugin extends Plugin {

    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String WSS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    private static final String CHROMIUM_VERSION = "143.0.3650.75";
    private static final String SEC_MS_GEC_VERSION = "2-" + CHROMIUM_VERSION;
    private static final String ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
    /** The endpoint resets idle or rate-limited connections; retry a few times. */
    private static final int MAX_ATTEMPTS = 4;
    private static final long SYNTH_TIMEOUT_MS = 25000L;
    private static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            // WebSocket frames arrive whenever the server finishes a chunk; a
            // read timeout would abort a long sentence mid-stream.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build();
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Identifies the sentence whose callbacks are still allowed to act. */
    private String activeId;
    /** Bumped on every retry so late frames from an old socket are ignored. */
    private int currentAttempt;
    private WebSocket socket;
    private ByteArrayOutputStream buffer;
    private MediaPlayer player;
    private File tempFile;
    private Runnable timeoutTask;

    /** Always available; network health is judged when a sentence is spoken. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        call.resolve(out);
    }

    /**
     * @param text  one sentence
     * @param rate  1.0 is natural speed, mapped onto SSML `prosody rate`
     * @param voice short name such as `zh-CN-YunxiNeural`
     * @param pitch optional prosody pitch such as `-6Hz`; shapes the character
     */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("empty-text");
            return;
        }
        String voice = call.getString("voice", "zh-CN-XiaoxiaoNeural");
        String pitch = call.getString("pitch", "+0Hz");
        double rate = call.getDouble("rate", 1.0);

        stopInternal();

        final String utteranceId = UUID.randomUUID().toString();
        synchronized (this) {
            activeId = utteranceId;
            buffer = new ByteArrayOutputStream();
            currentAttempt = 0;
        }
        connect(utteranceId, text, voice, pitch, rate, 0);

        timeoutTask = () -> fail(utteranceId, "timeout");
        handler.postDelayed(timeoutTask, SYNTH_TIMEOUT_MS);

        JSObject out = new JSObject();
        out.put("utteranceId", utteranceId);
        out.put("queued", true);
        call.resolve(out);
    }

    private void connect(
            String utteranceId, String text, String voice,
            String pitch, double rate, int attempt
    ) {
        synchronized (this) {
            currentAttempt = attempt;
        }
        String url = WSS_URL
                + "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN
                + "&Sec-MS-GEC=" + EdgeDrm.generateSecMsGec()
                + "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION
                + "&ConnectionId=" + UUID.randomUUID().toString().replace("-", "");
        Request request = new Request.Builder()
                .url(url)
                .header("Origin", ORIGIN)
                .header("User-Agent", USER_AGENT)
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Cookie", "muid=" + muid() + ";")
                .build();

        WebSocket ws = client.newWebSocket(
                request,
                new Listener(
                        utteranceId,
                        UUID.randomUUID().toString().replace("-", ""),
                        text, voice, pitch, rate, attempt
                )
        );
        synchronized (this) {
            socket = ws;
        }
    }

    private static String muid() {
        return UUID.randomUUID().toString().replace("-", "").toUpperCase(Locale.ROOT);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    private void stopInternal() {
        synchronized (this) {
            activeId = null;
        }
        releaseResources();
    }

    /** Drop socket, player and temp file without emitting any event. */
    private void releaseResources() {
        Runnable timeout = timeoutTask;
        timeoutTask = null;
        if (timeout != null) handler.removeCallbacks(timeout);

        WebSocket ws;
        MediaPlayer mp;
        File file;
        synchronized (this) {
            ws = socket;
            socket = null;
            mp = player;
            player = null;
            file = tempFile;
            tempFile = null;
            buffer = null;
        }
        if (ws != null) ws.cancel();
        if (mp != null) {
            try {
                mp.stop();
            } catch (Exception ignored) {
                // Already completed or released.
            }
            mp.release();
        }
        if (file != null) file.delete();
    }

    private boolean isActive(String id) {
        synchronized (this) {
            return id.equals(activeId);
        }
    }

    private void fail(String id, String reason) {
        synchronized (this) {
            if (!id.equals(activeId)) return;
            activeId = null;
        }
        /*
         * MediaPlayer must be released on the thread that created it. A new
         * sentence may already have claimed the plugin by the time this runs,
         * so only clean up when nothing newer is active — `speak` releases the
         * old player itself before starting.
         */
        handler.post(() -> {
            synchronized (EdgeTtsPlugin.this) {
                if (activeId == null) releaseResources();
            }
            JSObject data = new JSObject();
            data.put("utteranceId", id);
            data.put("reason", reason);
            notifyListeners("onError", data, true);
        });
    }

    private void notifyStart(String id) {
        JSObject data = new JSObject();
        data.put("utteranceId", id);
        notifyListeners("onStart", data, true);
    }

    private void notifyDone(String id) {
        JSObject data = new JSObject();
        data.put("utteranceId", id);
        notifyListeners("onDone", data, true);
    }

    private static String dateHeader() {
        // The service expects the JavaScript Date string the Edge extension sends.
        SimpleDateFormat fmt = new SimpleDateFormat(
                "EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'",
                Locale.US
        );
        fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
        return fmt.format(new Date());
    }

    private static String configMessage() {
        return "X-Timestamp:" + dateHeader() + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n"
                + "{\"context\":{\"synthesis\":{\"audio\":{"
                + "\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\","
                + "\"wordBoundaryEnabled\":\"false\"},"
                + "\"outputFormat\":\"" + OUTPUT_FORMAT + "\"}}}}\r\n";
    }

    private static String ssmlMessage(
            String requestId, String text, String voice, String pitch, double rate
    ) {
        String[] parts = voice.split("-");
        String lang = parts.length >= 2 ? parts[0] + "-" + parts[1] : "zh-CN";
        String body = escapeXml(text);
        int percent = (int) Math.round((rate - 1.0) * 100.0);
        String rateAttr = (percent >= 0 ? "+" : "") + percent + "%";
        String pitchAttr = pitch == null || pitch.isEmpty() ? "+0Hz" : pitch;

        String ssml = "<speak version='1.0' "
                + "xmlns='http://www.w3.org/2001/10/synthesis' "
                + "xml:lang='" + lang + "'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='" + escapeXml(pitchAttr) + "' "
                + "rate='" + rateAttr + "' volume='+0%'>"
                + body
                + "</prosody></voice></speak>";

        return "X-RequestId:" + requestId + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + dateHeader() + "\r\n"
                + "Path:ssml\r\n\r\n"
                + ssml;
    }

    private static String escapeXml(String s) {
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
    }

    /** Split the 2-byte big-endian header length off a binary frame. */
    private void appendAudio(byte[] data) {
        if (data.length < 2) return;
        int headerLength = ((data[0] & 0xFF) << 8) | (data[1] & 0xFF);
        if (data.length < 2 + headerLength) return;
        String header = new String(data, 2, headerLength, StandardCharsets.UTF_8);
        if (!header.contains("Path:audio")) return;
        synchronized (this) {
            if (buffer != null) {
                buffer.write(data, 2 + headerLength, data.length - 2 - headerLength);
            }
        }
    }

    private void onTurnEnd(String id, int attempt) {
        byte[] audio;
        synchronized (this) {
            if (!id.equals(activeId) || attempt != currentAttempt) return;
            audio = buffer == null ? new byte[0] : buffer.toByteArray();
            buffer = null;
        }
        if (audio.length == 0) {
            fail(id, "empty-audio");
            return;
        }
        try {
            File file = new File(getContext().getCacheDir(), "edge-tts-" + id + ".mp3");
            FileOutputStream out = new FileOutputStream(file);
            out.write(audio);
            out.close();
            handler.post(() -> play(id, file));
        } catch (Exception e) {
            fail(id, "write");
        }
    }

    private void play(String id, File file) {
        if (!isActive(id)) {
            file.delete();
            return;
        }
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(file.getAbsolutePath());
            mp.setOnPreparedListener(p -> {
                if (!isActive(id)) {
                    p.release();
                    file.delete();
                    return;
                }
                notifyStart(id);
                p.start();
            });
            mp.setOnCompletionListener(p -> {
                if (isActive(id)) {
                    synchronized (EdgeTtsPlugin.this) {
                        activeId = null;
                    }
                    releaseResources();
                    notifyDone(id);
                } else {
                    p.release();
                    file.delete();
                }
            });
            mp.setOnErrorListener((p, what, extra) -> {
                fail(id, "playback");
                return true;
            });
            synchronized (this) {
                player = mp;
                tempFile = file;
            }
            mp.prepareAsync();
        } catch (Exception e) {
            fail(id, "playback");
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    private final class Listener extends WebSocketListener {
        private final String utteranceId;
        private final String requestId;
        private final String text;
        private final String voice;
        private final String pitch;
        private final double rate;
        private final int attempt;
        /** Set once turn.end arrived, so the server closing is not an error. */
        private volatile boolean complete = false;

        Listener(
                String utteranceId, String requestId, String text,
                String voice, String pitch, double rate, int attempt
        ) {
            this.utteranceId = utteranceId;
            this.requestId = requestId;
            this.text = text;
            this.voice = voice;
            this.pitch = pitch;
            this.rate = rate;
            this.attempt = attempt;
        }

        /** A callback only acts if its sentence and attempt are still current. */
        private boolean isCurrent() {
            synchronized (EdgeTtsPlugin.this) {
                return utteranceId.equals(activeId) && attempt == currentAttempt;
            }
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (!isCurrent()) {
                webSocket.cancel();
                return;
            }
            webSocket.send(configMessage());
            webSocket.send(ssmlMessage(requestId, text, voice, pitch, rate));
        }

        @Override
        public void onMessage(WebSocket webSocket, String message) {
            if (!isCurrent()) return;
            if (message != null && message.contains("Path:turn.end")) {
                complete = true;
                onTurnEnd(utteranceId, attempt);
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            if (!isCurrent()) return;
            appendAudio(bytes.toByteArray());
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            if (!complete) retryOrFail("network");
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (complete) return;
            if (code == 1003 || code == 1007 || code == 1008) {
                // Malformed or unacceptable payload: the same SSML will fail again.
                fail(utteranceId, "closed");
            } else {
                retryOrFail("closed");
            }
        }

        private void retryOrFail(String reason) {
            if (!isCurrent()) return;
            if (attempt + 1 >= MAX_ATTEMPTS) {
                fail(utteranceId, reason);
                return;
            }
            // Partial audio from the failed attempt must not join the retry.
            synchronized (EdgeTtsPlugin.this) {
                buffer = new ByteArrayOutputStream();
            }
            connect(utteranceId, text, voice, pitch, rate, attempt + 1);
        }
    }
}
