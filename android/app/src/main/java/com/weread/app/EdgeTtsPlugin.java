package com.weread.app;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
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
 * file. The JS player asks one sentence ahead, so the next file is ready when
 * the current one ends and playback starts immediately instead of waiting for a
 * fresh network round trip. That wait was the long pause at every paragraph
 * boundary.
 *
 * `prefetch` goes one step further: the page asks for a whole chapter up front,
 * the plugin synthesises it with {@link #PREFETCH_CONCURRENCY} sockets and keeps
 * the mp3s in `cacheDir/edge-tts`. `speak` then finds the file already on disk,
 * so listening to a prepared chapter is pure local playback — no network in the
 * loop at all, and no gap between paragraphs. Files are keyed by
 * text+voice+pitch+rate, so changing any of those is a cache miss by design.
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

    private static final String DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
    /** Three sockets at a time keeps a chapter ahead of playback without abusing the endpoint. */
    private static final int PREFETCH_CONCURRENCY = 3;
    /**
     * Cache ceiling. One sentence is ~8–20 KB at this bitrate, so 400 files is
     * a few MB of app cache — enough for a couple of chapters, small enough
     * that Android never counts it against us.
     */
    private static final int MAX_CACHE_FILES = 400;
    private static final String CACHE_DIR = "edge-tts";

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
        /** True when `file` is a cached chapter mp3 that outlives this sentence. */
        boolean keepFile;
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

    /** Bumped by `cancelPrefetch`; a prefetcher from an older run stops writing. */
    private int prefetchGen;
    /** Sockets of the running prefetch, so a cancel can close them immediately. */
    private final List<WebSocket> prefetchSockets = new ArrayList<>();

    /** Always available; network health is judged when a sentence is spoken. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        call.resolve(out);
    }

    /* ---------- 章节音频缓存 ---------- */

    private File cacheDir() {
        File dir = new File(getContext().getCacheDir(), CACHE_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            // Fall back to the cache root; losing the subdirectory is harmless.
            return getContext().getCacheDir();
        }
        return dir;
    }

    /**
     * Identity of one sentence's audio. Every parameter that changes the sound
     * is part of the key — replaying at 1.3x after listening at 1.0x must not
     * reuse the 1.0x file.
     */
    private static String cacheKey(String text, String voice, String pitch, double rate) {
        String raw = voice + "|" + pitch + "|"
                + String.format(Locale.US, "%.2f", rate) + "|" + text;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] hash = md.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) sb.append(String.format(Locale.US, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(raw.hashCode());
        }
    }

    private File cacheFileOf(String text, String voice, String pitch, double rate) {
        return new File(cacheDir(), "edge-" + cacheKey(text, voice, pitch, rate) + ".mp3");
    }

    /** The cached mp3 for this sentence, or null when it has not been prepared. */
    private File cachedFileOf(String text, String voice, String pitch, double rate) {
        File f = cacheFileOf(text, voice, pitch, rate);
        // A half-written file is worse than a cache miss.
        return f.exists() && f.length() > 512 ? f : null;
    }

    /** Keep the newest {@link #MAX_CACHE_FILES}; drop the rest oldest-first. */
    private void trimCache() {
        File[] files = cacheDir().listFiles((dir, name) -> name.startsWith("edge-") && name.endsWith(".mp3"));
        if (files == null || files.length <= MAX_CACHE_FILES) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        long cutoff = System.currentTimeMillis() - 10 * 60 * 1000L;
        int excess = files.length - MAX_CACHE_FILES;
        for (File f : files) {
            if (excess <= 0) break;
            // Never pull a file out from under a prefetch that is still writing it.
            if (f.lastModified() > cutoff) break;
            if (f.delete()) excess--;
        }
    }

    /**
     * Synthesise a whole chapter ahead of playback.
     *
     * @param items   `[{ "text": "…" }]`, in reading order
     * @param voice   short name such as `zh-CN-YunxiNeural`
     * @param pitch   prosody pitch, same value `speak` would use
     * @param rate    playback rate; part of the cache key
     * @param token   opaque number echoed back on every progress event, so the
     *                page can ignore events from a superseded run
     *
     * Resolves with `{ok, failed, cached}` once every sentence has been dealt
     * with — the page decides how many sentences it actually waits for.
     */
    @PluginMethod
    public void prefetch(PluginCall call) {
        JSArray items = call.getArray("items");
        final String voice = call.getString("voice", DEFAULT_VOICE);
        final String pitch = call.getString("pitch", "+0Hz");
        final double rate = call.getDouble("rate", 1.0);
        final int token = call.getInt("token", 0);

        List<String> texts = new ArrayList<>();
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                try {
                    JSONObject o = items.getJSONObject(i);
                    String t = o.optString("text", "");
                    if (!t.trim().isEmpty()) texts.add(t);
                } catch (JSONException ignored) {
                    // Skip malformed entries; they are not worth failing the batch.
                }
            }
        }

        final Prefetcher job = new Prefetcher(texts, voice, pitch, rate, token, call);
        handler.post(job::start);
    }

    /** Abandon the running prefetch; its sockets close and partial files stay on disk. */
    @PluginMethod
    public void cancelPrefetch(PluginCall call) {
        handler.post(() -> {
            prefetchGen++;
            for (WebSocket ws : prefetchSockets) {
                try {
                    ws.cancel();
                } catch (Exception ignored) {
                    // Already closed.
                }
            }
            prefetchSockets.clear();
        });
        call.resolve();
    }

    /**
     * One prefetch run. Kept separate from the playback queue on purpose: the
     * player's `stop()` invalidates every queued sentence, and a preparation
     * that the user is still waiting for must not die with it.
     */
    private final class Prefetcher {
        private final List<String> texts;
        private final String voice;
        private final String pitch;
        private final double rate;
        private final int token;
        private final PluginCall call;
        private final int gen = prefetchGen;
        private int next;
        private int done;
        private int failed;
        private int cached;
        private int running;
        private boolean settled;

        Prefetcher(List<String> texts, String voice, String pitch, double rate, int token, PluginCall call) {
            this.texts = texts;
            this.voice = voice;
            this.pitch = pitch;
            this.rate = rate;
            this.token = token;
            this.call = call;
        }

        void start() {
            pump();
        }

        private boolean live() {
            return !settled && gen == prefetchGen;
        }

        private void pump() {
            if (!live()) {
                settle();
                return;
            }
            while (running < PREFETCH_CONCURRENCY && next < texts.size()) {
                String text = texts.get(next++);
                File hit = cachedFileOf(text, voice, pitch, rate);
                if (hit != null) {
                    cached++;
                    done++;
                    emitProgress();
                    continue;
                }
                running++;
                synth(text, 0);
            }
            if (running == 0 && next >= texts.size()) {
                settle();
            }
        }

        /** One sentence: connect, collect `Path:audio`, write the mp3, advance. */
        private void synth(String text, int attempt) {
            if (!live()) return;
            String requestId = UUID.randomUUID().toString().replace("-", "");
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

            WebSocket ws = client.newWebSocket(request, new WebSocketListener() {
                private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                private volatile boolean complete = false;

                @Override
                public void onOpen(WebSocket socket, Response response) {
                    if (!live()) {
                        socket.cancel();
                        return;
                    }
                    socket.send(configMessage());
                    socket.send(ssmlMessage(requestId, text, voice, pitch, rate));
                }

                @Override
                public void onMessage(WebSocket socket, String message) {
                    if (message != null && message.contains("Path:turn.end")) {
                        complete = true;
                        handler.post(() -> write(text));
                    }
                }

                @Override
                public void onMessage(WebSocket socket, ByteString bytes) {
                    byte[] data = bytes.toByteArray();
                    if (data.length < 2) return;
                    int headerLength = ((data[0] & 0xFF) << 8) | (data[1] & 0xFF);
                    if (data.length < 2 + headerLength) return;
                    String header = new String(data, 2, headerLength, StandardCharsets.UTF_8);
                    if (!header.contains("Path:audio")) return;
                    synchronized (buffer) {
                        if (live()) buffer.write(data, 2 + headerLength, data.length - 2 - headerLength);
                    }
                }

                @Override
                public void onFailure(WebSocket socket, Throwable t, Response response) {
                    if (complete) return;
                    handler.post(() -> retry(text, attempt));
                }

                @Override
                public void onClosed(WebSocket socket, int code, String reason) {
                    if (complete) return;
                    // Malformed SSML would fail identically on a retry.
                    if (code == 1003 || code == 1007 || code == 1008) handler.post(() -> give(text));
                    else handler.post(() -> retry(text, attempt));
                }

                /** Called on the main thread once the take is complete. */
                private void write(String text) {
                    byte[] audio;
                    synchronized (buffer) {
                        audio = buffer.toByteArray();
                    }
                    if (!live() || audio.length == 0) {
                        give(text);
                        return;
                    }
                    try {
                        File file = cacheFileOf(text, voice, pitch, rate);
                        FileOutputStream out = new FileOutputStream(file);
                        out.write(audio);
                        out.close();
                        done++;
                    } catch (Exception e) {
                        failed++;
                    } finally {
                        running--;
                        emitProgress();
                        pump();
                    }
                }
            });
            prefetchSockets.add(ws);
        }

        /** Retry once more, or count the sentence as failed. */
        private void retry(String text, int attempt) {
            if (!live()) {
                settle();
                return;
            }
            running--;
            if (attempt + 1 >= MAX_ATTEMPTS) {
                failed++;
                done++;
                emitProgress();
                pump();
                return;
            }
            running++;
            synth(text, attempt + 1);
        }

        private void give(String text) {
            if (!live()) {
                settle();
                return;
            }
            running--;
            failed++;
            done++;
            emitProgress();
            pump();
        }

        private void emitProgress() {
            if (!live()) return;
            JSObject data = new JSObject();
            data.put("token", token);
            data.put("done", done);
            data.put("total", texts.size());
            data.put("failed", failed);
            notifyListeners("onPrefetchProgress", data, true);
        }

        private void settle() {
            if (settled) return;
            settled = true;
            prefetchSockets.clear();
            trimCache();
            JSObject out = new JSObject();
            out.put("ok", done - failed);
            out.put("failed", failed);
            out.put("cached", cached);
            try {
                call.resolve(out);
            } catch (Exception ignored) {
                // The page may have dropped the call (navigated away).
            }
        }
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
        /*
         * A prepared chapter is played straight off disk: no socket, no wait,
         * and therefore no gap before this sentence starts.
         */
        File hit = cachedFileOf(job.text, job.voice, job.pitch, job.rate);
        if (hit != null) {
            job.file = hit;
            job.keepFile = true;
            job.ready = true;
            return;
        }
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
            // Cached chapter audio is shared with the prefetcher — keep it.
            if (!job.keepFile) job.file.delete();
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
            /*
             * Always write to the cache path, not a throwaway name: whatever
             * gets synthesised here is also the file the prefetcher would have
             * produced, so replaying the chapter — or resuming after a pause —
             * skips the network entirely.
             */
            File file = cacheFileOf(job.text, job.voice, job.pitch, job.rate);
            FileOutputStream out = new FileOutputStream(file);
            out.write(audio);
            out.close();
            job.file = file;
            job.keepFile = true;
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
            // Synthesised audio lands in the chapter cache and stays there.
            if (!job.keepFile) job.file.delete();
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
        handler.post(() -> {
            prefetchGen++;
            for (WebSocket ws : prefetchSockets) {
                try {
                    ws.cancel();
                } catch (Exception ignored) {
                    // Already closed.
                }
            }
            prefetchSockets.clear();
        });
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
