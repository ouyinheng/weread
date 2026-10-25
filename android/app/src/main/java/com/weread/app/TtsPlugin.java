package com.weread.app;

import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Read-aloud, backed by the phone's own speech engine.
 *
 * This is deliberately a local plugin rather than an npm package: the app must
 * not grow a dependency on a service, and the whole thing is ~150 lines over
 * `android.speech.tts.TextToSpeech`. Nothing leaves the device.
 *
 * Two properties of that Android API shape the interface:
 *
 *  - **No pause/resume.** The engine only has `speak` and `stop`. The JS player
 *    therefore treats a sentence as the atomic unit: pausing stops the engine
 *    and remembers the sentence index, resuming speaks that sentence again.
 *  - **Init is asynchronous.** `isAvailable()` reports what the engine said last
 *    time it initialised, and the JS side polls it briefly on first use instead
 *    of assuming the engine is ready the moment the plugin loads.
 *
 * The web layer never sees a promise per utterance: `speak` resolves as soon as
 * the text is queued, and completion arrives on the `onDone` / `onError`
 * listeners. Queueing is what makes a long chapter play without a round trip
 * between sentences.
 */
@CapacitorPlugin(name = "Tts")
public class TtsPlugin extends Plugin {

    /** Engine init has three outcomes the JS player asks about. */
    private static final String REASON_INIT_FAILED = "engine-init-failed";
    private static final String REASON_NO_CHINESE = "no-chinese-voice";
    private static final String REASON_NOT_READY = "engine-not-ready";

    private TextToSpeech engine;
    private volatile boolean initialised = false;
    private volatile String failure = REASON_NOT_READY;

    @Override
    public void load() {
        engine = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                failure = REASON_INIT_FAILED;
                return;
            }
            int lang = engine.setLanguage(Locale.SIMPLIFIED_CHINESE);
            if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                // The engine works but has no Chinese voice pack installed; the
                // UI offers the system TTS settings instead of failing silently.
                failure = REASON_NO_CHINESE;
            } else {
                failure = null;
            }
            initialised = true;
            attachListener();
        });
    }

    private void attachListener() {
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                JSObject data = new JSObject();
                data.put("utteranceId", utteranceId);
                notifyListeners("onStart", data, true);
            }

            @Override
            public void onDone(String utteranceId) {
                JSObject data = new JSObject();
                data.put("utteranceId", utteranceId);
                notifyListeners("onDone", data, true);
            }

            /** Pre-21 signature is still abstract on the base class. */
            @Override
            @SuppressWarnings("deprecation")
            public void onError(String utteranceId) {
                emitError(utteranceId);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                emitError(utteranceId);
            }

            private void emitError(String utteranceId) {
                JSObject data = new JSObject();
                data.put("utteranceId", utteranceId);
                notifyListeners("onError", data, true);
            }
        });
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", initialised && failure == null);
        if (failure != null) out.put("reason", failure);
        call.resolve(out);
    }

    /**
     * @param text  one sentence; the player never sends a whole chapter
     * @param rate  1.0 is the engine's natural speed
     * @param voice engine voice name from {@link #getVoices}, optional
     */
    @PluginMethod
    public void speak(PluginCall call) {
        if (!initialised || engine == null) {
            call.reject(REASON_NOT_READY);
            return;
        }
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("empty-text");
            return;
        }
        double rate = call.getDouble("rate", 1.0);
        String voiceName = call.getString("voice");

        engine.setSpeechRate((float) Math.max(0.3, Math.min(3.0, rate)));
        applyVoice(voiceName);

        String utteranceId = UUID.randomUUID().toString();
        Bundle params = new Bundle();
        // QUEUE_ADD lets the JS player hand us the next sentence while this one
        // is still playing, so the engine synthesises ahead instead of leaving
        // a silent gap. Every playback path calls stop() first, so the queue is
        // empty when a new run starts; FLUSH is not needed.
        int queued = engine.speak(text, TextToSpeech.QUEUE_ADD, params, utteranceId);
        JSObject out = new JSObject();
        out.put("utteranceId", utteranceId);
        out.put("queued", queued == TextToSpeech.SUCCESS);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (engine != null) engine.stop();
        call.resolve();
    }

    /** Voices the engine exposes, filtered by the caller to Chinese. */
    @PluginMethod
    public void getVoices(PluginCall call) {
        JSArray list = new JSArray();
        if (engine != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Set<Voice> voices = engine.getVoices();
            if (voices != null) {
                for (Voice v : voices) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale() == null ? "" : v.getLocale().toLanguageTag());
                    // localService == the voice synthesises on device, so picking
                    // only these keeps listening offline.
                    o.put("local", !v.isNetworkConnectionRequired());
                    list.put(o);
                }
            }
        }
        JSObject out = new JSObject();
        out.put("voices", list);
        call.resolve(out);
    }

    private void applyVoice(String voiceName) {
        if (voiceName == null || voiceName.isEmpty()) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        Set<Voice> voices = engine.getVoices();
        if (voices == null) return;
        for (Voice v : voices) {
            if (v.getName().equals(voiceName)) {
                engine.setVoice(v);
                return;
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (engine != null) {
            engine.stop();
            engine.shutdown();
            engine = null;
        }
        super.handleOnDestroy();
    }
}
