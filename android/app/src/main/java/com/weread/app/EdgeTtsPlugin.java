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
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
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
 * One WebSocket per sentence, but **two sentences are in flight**: while
 * sentence N is playing, sentence N+1 is already being synthesised into its own
 * temp file. The JS player asks one sentence ahead, so the next file is ready
 * when the current one ends and playback starts immediately instead of waiting
 * for a fresh network round trip. That wait was the long pause at every
 * paragraph boundary.
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

    /** One sentence: its socket, audio buffer and temp file. */
    private static final class Job {
        final String id;
        final String text;
        final String voice;
        final String pitch;
        final double rate;
        final int session;
        final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        WebSocket socket;
        File file;
        volatile int attempt;
        boolean started;
        boolean ready;
        Runnable timeout;

        Job(String id, String text, String voice, String pitch, double rate, int session) {
            this.id = id;
            this.text = text;
            this.voice = voice;
            this.pitch = pitch;
            this.rate = rate;
            this.session = session;
        }
    }

    /** Queued sentences, head first. Mutated on the main thread only. */
    private final List<Job> queue = new ArrayList<>();
    private MediaPlayer player;
    private Job playing;
    /** Bumped on stop so late socket callbacks can tell they are stale. */
    private volatile int session;

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
        final String voice = call.getString("voice", "zh-CN-XiaoxiaoNeural");
        final String pitch = call.getString("pitch", "+0Hz");
        final double rate = call.getDouble("rate", 1.0);
        final String utteranceId = UUID.randomUUID().toString();

        JSObject out = new JSObject();
        out.put("utteranceId", utteranceId);
        out.put("queued", true);
        call.resolve(out);

        // Queue on the main thread so speak()/stop() are strictly ordered.
        handler.post(() -> {
            Job job = new Job(utteranceId, text, voice, pitch, rate, session);
            queue.add(job);
            pump();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        handler.post(this::stopInternal);
        call.resolve();
    }

    private void stopInternal() {
        session++;
        List<Job> jobs = new ArrayList<>(queue);
        queue.clear();
        playing = null;
        for (Job job : jobs) cancelJob(job);
        releasePlayer();
    }

    /**
     * Keep the head playing and the next sentence synthesising. Called on the
     * main thread after every queue/playback transition.
     */
    private void pump() {
        if (queue.isEmpty()) return;

        Job head = queue.get(0);
        if (!head.started) startSynthesis(head);

        if (queue.size() > 1) {
            Job next = queue.get(1);
            if (!next.started) startSynthesis(next);
        }

        if (playing == null && head.ready) playHead(head);
    }

    private void startSynthesis(Job job) {
        job.started = true;
        job.attempt = 0;
        job.timeout = () -> fail(job, "timeout");
        handler.postDelayed(job.timeout, SYNTH_TIMEOUT_MS);
        connect(job);
    }

    private void connect(Job job) {
        if (!isCurrent(job)) return;

        WebSocket old = job.socket;
        if (old != null) old.cancel();

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

        job.socket = client.newWebSocket(
                request,
                new Listener(job, job.attempt, UUID.randomUUID().toString().replace("-", ""))
        );
    }

    private static String muid() {
        return UUID.randomUUID().toString().replace("-", "").toUpperCase(Locale.ROOT);
    }

    /** Main-thread check: this job belongs to the current run and is still queued. */
    private boolean isCurrent(Job job) {
        return job.session == session && queue.contains(job);
    }

    /** Off-main-thread check: the run and the connection attempt are both current. */
    private boolean isLive(Job job, int attempt) {
        return job.session == session && job.attempt == attempt;
    }

    private void cancelJob(Job job) {
        clearTimeout(job);
        WebSocket ws = job.socket;
        job.socket = null;
        if (ws != null) ws.cancel();
        if (job.file != null) {
            job.file.delete();
            job.file = null;
        }
        job.ready = false;
    }

    private void clearTimeout(Job job) {
        Runnable timeout = job.timeout;
        job.timeout = null;
        if (timeout != null) handler.removeCallbacks(timeout);
    }

    private void releasePlayer() {
        MediaPlayer mp = player;
        player = null;
        if (mp != null) {
            try {
                mp.stop();
            } catch (Exception ignored) {
                // Already completed or released.
            }
            mp.release();
        }
    }

    private void fail(Job job, String reason) {
        if (!isCurrent(job)) return;
        queue.remove(job);
        if (playing == job) {
            playing = null;
            releasePlayer();
        }
        cancelJob(job);
        notifyError(job.id, reason);
        pump();
    }

    private void onTurnEnd(Job job, int attempt) {
        if (!isCurrent(job) || job.attempt != attempt) return;

        byte[] audio;
        synchronized (job.buffer) {
            audio = job.buffer.toByteArray();
            job.buffer.reset();
        }
        if (audio.length == 0) {
            fail(job, "empty-audio");
            return;
        }
        try {
            File file = new File(getContext().getCacheDir(), "edge-tts-" + job.id + ".mp3");
            FileOutputStream out = new FileOutputStream(file);
            out.write(audio);
            out.close();
            job.file = file;
            job.ready = true;
            clearTimeout(job);
            pump();
        } catch (Exception e) {
            fail(job, "write");
        }
    }

    private void playHead(Job job) {
        if (playing != null || !isCurrent(job) || !job.ready || job.file == null) return;
        playing = job;

        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(job.file.getAbsolutePath());
            mp.setOnPreparedListener(p -> {
                if (playing != job || !isCurrent(job)) {
                    if (player == p) player = null;
                    p.release();
                    return;
                }
                notifyStart(job.id);
                p.start();
            });
            mp.setOnCompletionListener(p -> handler.post(() -> finish(job, p)));
            mp.setOnErrorListener((p, what, extra) -> {
                fail(job, "playback");
                return true;
            });
            player = mp;
            mp.prepareAsync();
        } catch (Exception e) {
            playing = null;
            fail(job, "playback");
        }
    }

    private void finish(Job job, MediaPlayer mp) {
        if (playing != job) {
            if (player == mp) player = null;
            try {
                mp.release();
            } catch (Exception ignored) {
                // Already released.
            }
            return;
        }
        playing = null;
        if (player == mp) player = null;
        try {
            mp.release();
        } catch (Exception ignored) {
            // Already released.
        }
        queue.remove(job);
        job.ready = false;
        if (job.file != null) {
            job.file.delete();
            job.file = null;
        }
        notifyDone(job.id);
        pump();
    }

    private void appendAudio(Job job, byte[] data, int attempt) {
        if (data.length < 2) return;
        int headerLength = ((data[0] & 0xFF) << 8) | (data[1] & 0xFF);
        if (data.length < 2 + headerLength) return;
        String header = new String(data, 2, headerLength, StandardCharsets.UTF_8);
        if (!header.contains("Path:audio")) return;
        synchronized (job.buffer) {
            if (job.attempt == attempt) {
                job.buffer.write(data, 2 + headerLength, data.length - 2 - headerLength);
            }
        }
    }

    private void retryOrFail(Job job, int attempt, String reason) {
        if (!isCurrent(job) || job.attempt != attempt) return;
        if (attempt + 1 >= MAX_ATTEMPTS) {
            fail(job, reason);
            return;
        }
        job.attempt = attempt + 1;
        synchronized (job.buffer) {
            job.buffer.reset();
        }
        WebSocket old = job.socket;
        job.socket = null;
        if (old != null) old.cancel();
        connect(job);
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

    private void notifyError(String id, String reason) {
        JSObject data = new JSObject();
        data.put("utteranceId", id);
        data.put("reason", reason);
        notifyListeners("onError", data, true);
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

    @Override
    protected void handleOnDestroy() {
        handler.post(this::stopInternal);
        super.handleOnDestroy();
    }

    private final class Listener extends WebSocketListener {
        private final Job job;
        private final int attempt;
        private final String requestId;
        /** Set once turn.end arrived, so the server closing is not an error. */
        private volatile boolean complete = false;

        Listener(Job job, int attempt, String requestId) {
            this.job = job;
            this.attempt = attempt;
            this.requestId = requestId;
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (!isLive(job, attempt)) {
                webSocket.cancel();
                return;
            }
            webSocket.send(configMessage());
            webSocket.send(ssmlMessage(requestId, job.text, job.voice, job.pitch, job.rate));
        }

        @Override
        public void onMessage(WebSocket webSocket, String message) {
            if (!isLive(job, attempt)) return;
            if (message != null && message.contains("Path:turn.end")) {
                complete = true;
                handler.post(() -> onTurnEnd(job, attempt));
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            if (!isLive(job, attempt)) return;
            appendAudio(job, bytes.toByteArray(), attempt);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            if (complete) return;
            handler.post(() -> retryOrFail(job, attempt, "network"));
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (complete) return;
            if (code == 1003 || code == 1007 || code == 1008) {
                // Malformed or unacceptable payload: the same SSML will fail again.
                handler.post(() -> fail(job, "closed"));
            } else {
                handler.post(() -> retryOrFail(job, attempt, "closed"));
            }
        }
    }
}
