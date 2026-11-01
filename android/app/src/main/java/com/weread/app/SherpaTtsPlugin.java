package com.weread.app;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import kotlin.jvm.functions.Function1;

/**
 * 离线神经语音（sherpa-onnx）朗读。
 *
 * 为什么换掉系统的 TextToSpeech：那个接口是「一句一次合成、一次播放」，
 * 句子与段落之间必然有一次引擎重启的静音，长章节听下来一串空洞。这里的
 * 做法是**一路连续的 PCM**：
 *
 *   JS 给文本  →  合成线程（sherpa 逐块吐 float 采样）
 *              →  有界缓冲
 *              →  播放线程（写进同一条 AudioTrack，卡住时天然背压）
 *
 * 因为 AudioTrack 只有一条、从不停下重开，句子边界、段落边界都只是缓冲里
 * 多了几个采样块，听不到接缝；合成比真人说话快（RTF < 1），缓冲永远填得住。
 *
 * 模型随包放在 assets 里，sherpa 的 `OfflineTts(AssetManager, config)` 直接
 * 从 assets 读，不需要先拷贝一份到私有目录。
 */
@CapacitorPlugin(name = "SherpaTts")
public class SherpaTtsPlugin extends Plugin {

    /** assets 下的模型目录（与 release 包内的目录名一致）。 */
    private static final String MODEL_NAME = "vits-zh-hf-fanchen-C";
    private static final String MODEL_DIR = "sherpa-onnx/" + MODEL_NAME;
    private static final String MODEL_FILE = MODEL_DIR + "/" + MODEL_NAME + ".onnx";
    /** 模型换了就改这里，私有目录里的旧拷贝会自动重建。 */
    private static final String MODEL_VERSION = "zh-hf-fanchen-C-1";
    private static final String TOKENS_FILE = MODEL_DIR + "/tokens.txt";
    private static final String LEXICON_FILE = MODEL_DIR + "/lexicon.txt";
    private static final String DICT_DIR = MODEL_DIR + "/dict";
    /**
     * 中文数字/日期/电话号码的读法规则。没有它们，「2024年」会被逐字念成
     * 「二零二四年」，小说里的年份日期全都不对味。
     */
    private static final String[] RULE_FSTS = {"date.fst", "number.fst", "phone.fst", "new_heteronym.fst"};

    /** 缓冲区里放多少个采样块（每块约 0.3–0.5 s）。 */
    private static final int BUFFER_BLOCKS = 12;

    private final Handler main = new Handler(Looper.getMainLooper());

    private OfflineTts tts;
    private AudioTrack track;
    private int sampleRate;

    private Thread synthThread;
    private Thread writeThread;
    private volatile boolean running;
    /** 每次 stop 自增；合成回调看到它变了就立刻收手。 */
    private volatile long generation;

    private final LinkedBlockingQueue<Job> jobs = new LinkedBlockingQueue<>();
    private final ArrayBlockingQueue<Block> audio = new ArrayBlockingQueue<>(BUFFER_BLOCKS);

    private volatile boolean preparing;
    private volatile String failure;
    /** 播放线程里记着「现在念的是哪一段」，id 变了就发 onStart。 */
    private volatile String playingId;

    /** 一条待朗读的文本。 */
    private static final class Job {
        final String id;
        final String text;
        final float speed;

        Job(String id, String text, float speed) {
            this.id = id;
            this.text = text;
            this.speed = speed;
        }
    }

    /** 采样块；`last` 标记这一段话合成完了，播放线程据此发 onDone。 */
    private static final class Block {
        final String id;
        final float[] samples;
        final boolean last;
        /** 生成时所属的播放代次；stop() 之后旧块一律丢弃，不会再响一下。 */
        final long gen;

        Block(String id, float[] samples, boolean last, long gen) {
            this.id = id;
            this.samples = samples;
            this.last = last;
            this.gen = gen;
        }
    }

    /* ---------- 生命周期 ---------- */

    @Override
    public void load() {
        startThreads();
    }

    /** 模型在不在包里、引擎现在是不是已经加载好。加载本身走 `prepare`。 */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        boolean bundled = assetExists(MODEL_FILE);
        out.put("available", bundled);
        out.put("ready", tts != null);
        if (!bundled) out.put("reason", "model-missing");
        else if (failure != null) out.put("reason", failure);
        call.resolve(out);
    }

    /**
     * 加载模型（首次约 2–4 秒，之后同一个进程里不用再加载）。
     *
     * 前端在打开阅读页时就调，让这段等待发生在用户还没点「听」的时候。
     */
    @PluginMethod
    public void prepare(PluginCall call) {
        if (tts != null) {
            resolveReady(call);
            return;
        }
        if (!assetExists(MODEL_FILE)) {
            resolveFailed(call, "model-missing");
            return;
        }
        if (preparing) {
            // 已经在加载：让调用方等一小会儿再看结果，而不是各加载一份。
            new Thread(() -> {
                for (int i = 0; i < 120 && preparing; i++) sleep(250);
                if (tts != null) resolveReady(call);
                else resolveFailed(call, failure == null ? "prepare-timeout" : failure);
            }, "sherpa-wait").start();
            return;
        }

        preparing = true;
        emit("onPrepareProgress", new JSObject().put("phase", "loading"));
        new Thread(() -> {
            String error = null;
            try {
                openModel();
            } catch (Throwable t) {
                error = String.valueOf(t.getMessage() == null ? t : t.getMessage());
            } finally {
                preparing = false;
            }
            if (tts != null) {
                failure = null;
                emit("onPrepareProgress", new JSObject().put("phase", "ready"));
                resolveReady(call);
            } else {
                failure = error == null ? "prepare-failed" : error;
                emit("onPrepareProgress", new JSObject().put("phase", "failed").put("reason", failure));
                resolveFailed(call, failure);
            }
        }, "sherpa-prepare").start();
    }

    /**
     * Load the model, preferring the assets copy and falling back to a real
     * file copy.
     *
     * sherpa-onnx can read the model straight out of `assets` through
     * `AssetManager`, which costs no extra storage — but the字典 (jieba) is a
     * directory, and directory support in the asset file system has varied
     * between releases. If anything about that path fails, copy the model once
     * into the private directory and load from real paths instead: slower on
     * the first run, identical afterwards.
     */
    private void openModel() throws Exception {
        try {
            tts = buildEngine(getContext().getAssets(),
                    MODEL_FILE, LEXICON_FILE, TOKENS_FILE, DICT_DIR, ruleFsts());
            sampleRate = tts.sampleRate();
            return;
        } catch (Throwable fromAssets) {
            emit("onPrepareProgress", new JSObject().put("phase", "copy"));
            File dir = materialize();
            String base = dir.getAbsolutePath();
            tts = buildEngine(null,
                    base + "/" + MODEL_NAME,
                    base + "/lexicon.txt",
                    base + "/tokens.txt",
                    base + "/dict",
                    rulePaths(base));
            sampleRate = tts.sampleRate();
        }
    }

    /**
     * Build one engine.
     *
     * @param assets 非空表示按 assets 里的相对路径读（不占额外存储）；
     *               传 null 表示下面给的是真实文件路径。
     */
    private OfflineTts buildEngine(android.content.res.AssetManager assets,
                                   String model, String lexicon, String tokens, String dict, String rules) {
        OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig(
                model,
                lexicon,
                tokens,
                "",          // espeak 数据目录：这个模型用不到
                dict,        // jieba 词典
                0.667f,      // noiseScale
                0.8f,        // noiseScaleW
                1.0f         // lengthScale（语速由 generate 的 speed 控制）
        );
        OfflineTtsModelConfig cfgModel = new OfflineTtsModelConfig();
        cfgModel.setVits(vits);
        int cores = Runtime.getRuntime().availableProcessors();
        cfgModel.setNumThreads(Math.max(1, Math.min(4, cores / 2)));
        cfgModel.setDebug(false);
        cfgModel.setProvider("cpu");

        OfflineTts engine;
        try {
            engine = new OfflineTts(assets, new OfflineTtsConfig(cfgModel, rules, "", 1, 0.2f));
        } catch (Throwable withRules) {
            /*
             * 读法规则（fst）是锦上添花：某个机型上如果它加载不了，宁可退回到
             * 没有规则的引擎，也不该让整个听书不可用。
             */
            engine = new OfflineTts(assets, new OfflineTtsConfig(cfgModel, "", "", 1, 0.2f));
        }
        return engine;
    }

    /**
     * Copy the bundled model into the private directory once.
     *
     * Keyed by {@link #MODEL_VERSION}: bumping it re-copies, so a model swap in
     * a future update does not leave a stale file behind.
     */
    private File materialize() throws Exception {
        File root = new File(getContext().getFilesDir(), "sherpa-tts/" + MODEL_VERSION);
        File marker = new File(root, ".ready");
        File dir = new File(root, MODEL_NAME);
        if (marker.exists() && new File(dir, MODEL_NAME).length() > 10_000_000L) return dir;

        File tmp = new File(getContext().getFilesDir(), "sherpa-tts/" + MODEL_VERSION + ".part");
        deleteTree(tmp);
        if (!tmp.mkdirs() && !tmp.isDirectory()) throw new Exception("cannot create " + tmp);

        List<String> files = new ArrayList<>();
        long total = collect(MODEL_DIR, files);
        long copied = 0;
        long lastReport = 0;
        byte[] buf = new byte[64 * 1024];
        for (String path : files) {
            File out = new File(tmp, path.substring(MODEL_DIR.length() + 1));
            File parent = out.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new Exception("cannot create " + parent);
            try (InputStream in = getContext().getAssets().open(path);
                 FileOutputStream os = new FileOutputStream(out)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    copied += n;
                    // 每 8MB 报一次，进度条动起来但不刷屏
                    if (copied - lastReport > 8L * 1024 * 1024) {
                        lastReport = copied;
                        JSObject p = new JSObject();
                        p.put("phase", "copy");
                        p.put("done", copied / 1024);
                        p.put("total", total / 1024);
                        emit("onPrepareProgress", p);
                    }
                }
            }
        }
        deleteTree(root);
        if (!tmp.renameTo(root)) {
            // 极端情况下 rename 失败（跨挂载点），就地使用 .part 目录。
            return new File(tmp, MODEL_NAME);
        }
        //noinspection ResultOfMethodCallIgnored
        marker.createNewFile();
        return new File(root, MODEL_NAME);
    }

    /** Walk one asset directory, appending file paths; returns their total size. */
    private long collect(String path, List<String> out) throws Exception {
        String[] children = getContext().getAssets().list(path);
        if (children == null || children.length == 0) {
            out.add(path);
            return getContext().getAssets().open(path).available();
        }
        long total = 0;
        for (String child : children) total += collect(path + "/" + child, out);
        return total;
    }

    private void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] kids = file.listFiles();
        if (kids != null) for (File kid : kids) deleteTree(kid);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private String ruleFsts() {
        StringBuilder sb = new StringBuilder();
        for (String name : RULE_FSTS) {
            String path = MODEL_DIR + "/" + name;
            if (!assetExists(path)) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(path);
        }
        return sb.toString();
    }

    private String rulePaths(String base) {
        StringBuilder sb = new StringBuilder();
        for (String name : RULE_FSTS) {
            File f = new File(base, name);
            if (!f.exists()) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(f.getAbsolutePath());
        }
        return sb.toString();
    }

    private boolean assetExists(String path) {
        try {
            getContext().getAssets().open(path).close();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------- 朗读 ---------- */

    /**
     * @param text  一段话（前端已经把几句拼成一段，见 chunker.ts）
     * @param rate  语速倍数，1.0 为自然语速
     */
    @PluginMethod
    public void speak(PluginCall call) {
        if (tts == null) {
            call.reject("not-ready");
            return;
        }
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("empty-text");
            return;
        }
        double rate = call.getDouble("rate", 1.0);
        String id = UUID.randomUUID().toString();

        float speed = (float) Math.max(0.5, Math.min(2.0, rate));
        jobs.add(new Job(id, text, speed));

        JSObject out = new JSObject();
        out.put("utteranceId", id);
        out.put("queued", true);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        generation++;
        playingId = null;
        jobs.clear();
        audio.clear();
        pauseTrack();
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        JSArray list = new JSArray();
        if (tts != null) {
            int speakers = tts.numSpeakers();
            for (int i = 0; i < Math.max(1, speakers); i++) {
                JSObject v = new JSObject();
                v.put("name", "sherpa:" + i);
                v.put("lang", "zh-CN");
                v.put("local", true);
                v.put("label", speakers > 1 ? "本地离线 · 音色 " + (i + 1) : "本地离线 · 女声");
                list.put(v);
            }
        }
        JSObject out = new JSObject();
        out.put("voices", list);
        call.resolve(out);
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        generation++;
        jobs.clear();
        audio.clear();
        if (synthThread != null) synthThread.interrupt();
        if (writeThread != null) writeThread.interrupt();
        releaseTrack();
        if (tts != null) {
            tts.release();
            tts = null;
        }
        super.handleOnDestroy();
    }

    /* ---------- 两条线程：合成 → 缓冲 → 播放 ---------- */

    private void startThreads() {
        if (running) return;
        running = true;

        synthThread = new Thread(() -> {
            while (running) {
                Job job;
                try {
                    job = jobs.poll(300, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    return;
                }
                if (job == null) continue;
                final long gen = generation;
                final String id = job.id;
                try {
                    tts.generateWithCallback(job.text, 0, job.speed, new Function1<float[], Integer>() {
                        @Override
                        public Integer invoke(float[] samples) {
                            if (gen != generation) return 0;
                            return offer(new Block(id, samples, false, gen));
                        }
                    });
                } catch (Throwable t) {
                    emit("onError", event(id).put("reason", String.valueOf(t.getMessage())));
                    continue;
                }
                if (gen == generation) offer(new Block(id, null, true, gen));
            }
        }, "sherpa-synth");

        writeThread = new Thread(() -> {
            while (running) {
                Block block;
                try {
                    block = audio.poll(300, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    return;
                }
                if (block == null) continue;
                if (block.gen != generation) continue;
                if (block.last) {
                    playingId = null;
                    emit("onDone", event(block.id));
                    continue;
                }
                write(block);
            }
        }, "sherpa-play");

        synthThread.start();
        writeThread.start();
    }

    /** 往缓冲里放一块；满了就等播放线程消费，形成背压。 */
    private int offer(Block block) {
        try {
            return audio.offer(block, 1, TimeUnit.SECONDS) ? 1 : 0;
        } catch (InterruptedException e) {
            return 0;
        }
    }

    private void write(Block block) {
        AudioTrack t = ensureTrack();
        if (t == null) return;
        if (!block.id.equals(playingId)) {
            playingId = block.id;
            emit("onStart", event(block.id));
        }
        float[] samples = block.samples;
        int offset = 0;
        while (offset < samples.length) {
            int n = t.write(samples, offset, samples.length - offset, AudioTrack.WRITE_BLOCKING);
            if (n <= 0) return;
            offset += n;
        }
    }

    private AudioTrack ensureTrack() {
        int rate = sampleRate > 0 ? sampleRate : 22050;
        if (track != null && track.getState() == AudioTrack.STATE_INITIALIZED) {
            if (track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) track.play();
            return track;
        }
        releaseTrack();
        int min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
        int size = Math.max(min * 2, rate / 2 * 4);   // 至少 0.5 s 的缓冲
        try {
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                            .setSampleRate(rate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(size)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            track.play();
            return track;
        } catch (Throwable t) {
            track = null;
            return null;
        }
    }

    private void pauseTrack() {
        AudioTrack t = track;
        if (t == null) return;
        try {
            t.pause();
            t.flush();
        } catch (Throwable ignored) {
            // 已经停了
        }
    }

    private void releaseTrack() {
        AudioTrack t = track;
        track = null;
        if (t == null) return;
        try {
            t.stop();
        } catch (Throwable ignored) {
            // 已经停了
        }
        try {
            t.release();
        } catch (Throwable ignored) {
            // 已经释放
        }
    }

    /* ---------- 事件 ---------- */

    private JSObject event(String id) {
        return new JSObject().put("utteranceId", id);
    }

    private void emit(String name, JSObject data) {
        main.post(() -> notifyListeners(name, data, true));
    }

    private void resolveReady(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ready", true);
        call.resolve(out);
    }

    private void resolveFailed(PluginCall call, String reason) {
        JSObject out = new JSObject();
        out.put("ready", false);
        out.put("reason", reason);
        call.resolve(out);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
