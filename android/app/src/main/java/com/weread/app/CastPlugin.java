package com.weread.app;

import android.content.Context;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 投屏（DLNA / UPnP AV）。
 *
 * 为什么是 DLNA 而不是 Cast SDK：
 *
 *  - 国内电视盒子、投影、智能电视的「投屏」入口绝大多数就是 DLAN/UPnP 的
 *    MediaRenderer，不依赖 Google Play 服务（很多设备根本没装）；
 *  - Cast SDK 需要 play-services 依赖 + 接收端注册，包体和可用性都不合适；
 *  - AirPlay 只能在苹果生态里用，Android 端做不了接收端发现。
 *
 * 实现上是「发现 → 拿描述 → 发 SOAP」三步，全部走系统 API，没有第三方库：
 *
 *  1. SSDP 组播 M-SEARCH（239.255.255.250:1900）问 MediaRenderer:1，
 *     收集回包里的 LOCATION；
 *  2. 抓 LOCATION 那份 device description XML，取 friendlyName 和
 *     AVTransport 服务的 controlURL；
 *  3. 向 controlURL 发 SetAVTransportURI（带上 DIDL-Lite 元数据）+ Play。
 *
 * 全部在后台线程跑，任何一步失败都只影响这一次调用，不会把播放页卡住。
 * 组播需要 MulticastLock，否则不少机型（尤其省电模式下）收不到回包。
 */
@CapacitorPlugin(name = "Cast")
public class CastPlugin extends Plugin {

    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final String ST_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";
    private static final String AVT = "urn:schemas-upnp-org:service:AVTransport:1";

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(3, TimeUnit.SECONDS)
            .build();

    /** 正在投的设备，只用于 JS 侧显示「投屏中」。 */
    private String activeName = "";
    private String activeControl = "";

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        call.resolve(out);
    }

    @PluginMethod
    public void discover(final PluginCall call) {
        new Thread(() -> {
            try {
                List<JSObject> found = search(3200);
                JSArray list = new JSArray();
                for (JSObject o : found) list.put(o);
                JSObject out = new JSObject();
                out.put("devices", list);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("discover-failed: " + e.getMessage());
            }
        }, "cast-discover").start();
    }

    @PluginMethod
    public void cast(final PluginCall call) {
        final String control = call.getString("controlUrl", "");
        final String url = call.getString("url", "");
        final String title = call.getString("title", "");
        final String name = call.getString("name", "");
        if (control == null || control.isEmpty() || url == null || url.isEmpty()) {
            call.reject("missing-url");
            return;
        }
        new Thread(() -> {
            try {
                soap(control, "SetAVTransportURI",
                        "<InstanceID>0</InstanceID>"
                                + "<CurrentURI>" + xmlEscape(url) + "</CurrentURI>"
                                + "<CurrentURIMetaData>" + xmlEscape(didl(title, url)) + "</CurrentURIMetaData>");
                soap(control, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
                activeControl = control;
                activeName = name == null ? "" : name;
                JSObject out = new JSObject();
                out.put("ok", true);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("cast-failed: " + e.getMessage());
            }
        }, "cast-send").start();
    }

    @PluginMethod
    public void stopCast(final PluginCall call) {
        final String control = activeControl;
        if (control == null || control.isEmpty()) {
            call.resolve(new JSObject().put("ok", true));
            return;
        }
        new Thread(() -> {
            try {
                soap(control, "Stop", "<InstanceID>0</InstanceID>");
            } catch (Exception ignored) {
                /* 设备可能已经关机：停止失败不该拦住界面 */
            }
            activeControl = "";
            activeName = "";
            call.resolve(new JSObject().put("ok", true));
        }, "cast-stop").start();
    }

    @PluginMethod
    public void status(final PluginCall call) {
        JSObject out = new JSObject();
        out.put("casting", activeControl != null && !activeControl.isEmpty());
        out.put("name", activeName);
        call.resolve(out);
    }

    /* ---------- SSDP ---------- */

    private List<JSObject> search(int waitMs) throws Exception {
        List<JSObject> devices = new ArrayList<>();
        Map<String, String> locations = new LinkedHashMap<>();

        WifiManager.MulticastLock lock = null;
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                lock = wifi.createMulticastLock("weread-cast");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        } catch (Exception ignored) {
            /* 没有 wifi 服务也能继续：有线网络下组播通常照样可用 */
        }

        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            socket.setSoTimeout(400);
            byte[] req = ("M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: " + ST_RENDERER + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
            socket.send(new DatagramPacket(req, req.length,
                    new InetSocketAddress(InetAddress.getByName(SSDP_ADDR), SSDP_PORT)));

            long deadline = System.currentTimeMillis() + waitMs;
            byte[] buf = new byte[4096];
            while (System.currentTimeMillis() < deadline) {
                try {
                    DatagramPacket res = new DatagramPacket(buf, buf.length);
                    socket.receive(res);
                    String text = new String(res.getData(), 0, res.getLength(), StandardCharsets.UTF_8);
                    String location = header(text, "LOCATION");
                    if (location != null && !locations.containsKey(location)) {
                        locations.put(location, location);
                    }
                } catch (Exception timeout) {
                    /* 400ms 没回包就再等下一轮，直到总超时 */
                }
            }
        } finally {
            if (socket != null) socket.close();
            if (lock != null && lock.isHeld()) lock.release();
        }

        // 拉描述：设备可能已经下线，单个失败就跳过
        for (String location : locations.keySet()) {
            try {
                JSObject d = describe(location);
                if (d != null) devices.add(d);
            } catch (Exception ignored) {
                /* 忽略这一台 */
            }
        }
        return devices;
    }

    private String header(String packet, String name) {
        for (String line : packet.split("\r\n")) {
            int i = line.indexOf(':');
            if (i <= 0) continue;
            if (line.substring(0, i).trim().equalsIgnoreCase(name)) {
                return line.substring(i + 1).trim();
            }
        }
        return null;
    }

    /** 解析 device description，拿到名字和 AVTransport 的 controlURL。 */
    private JSObject describe(String location) throws Exception {
        Request req = new Request.Builder().url(location).build();
        String xml;
        try (Response res = HTTP.newCall(req).execute()) {
            if (res.body() == null) return null;
            xml = res.body().string();
        }
        if (xml == null || !xml.contains("<")) return null;

        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(false);
        DocumentBuilder b = f.newDocumentBuilder();
        Document doc = b.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));

        String friendly = textOf(doc, "friendlyName");
        String model = textOf(doc, "modelName");

        String control = null;
        NodeList services = doc.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            Element svc = (Element) services.item(i);
            String type = childText(svc, "serviceType");
            if (type != null && type.contains("AVTransport")) {
                String raw = childText(svc, "controlURL");
                if (raw != null && !raw.isEmpty()) {
                    control = resolve(location, raw);
                    break;
                }
            }
        }
        if (control == null) return null;

        JSObject out = new JSObject();
        out.put("id", location);
        out.put("name", friendly == null || friendly.isEmpty() ? "电视" : friendly);
        out.put("model", model == null ? "" : model);
        out.put("location", location);
        out.put("controlUrl", control);
        return out;
    }

    private String textOf(Document doc, String tag) {
        NodeList list = doc.getElementsByTagName(tag);
        if (list.getLength() == 0) return null;
        return list.item(0).getTextContent();
    }

    private String childText(Element parent, String tag) {
        NodeList list = parent.getElementsByTagName(tag);
        if (list.getLength() == 0) return null;
        return list.item(0).getTextContent();
    }

    private String resolve(String base, String href) {
        try {
            URI b = URI.create(base);
            URI r = b.resolve(href);
            return r.toString();
        } catch (Exception e) {
            return href;
        }
    }

    /* ---------- SOAP ---------- */

    private void soap(String controlUrl, String action, String inner) throws Exception {
        String body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                + "<s:Body><u:" + action + " xmlns:u=\"" + AVT + "\">" + inner + "</u:" + action + "></s:Body>"
                + "</s:Envelope>";
        Request req = new Request.Builder()
                .url(controlUrl)
                .header("SOAPACTION", "\"" + AVT + "#" + action + "\"")
                .header("Content-Type", "text/xml; charset=\"utf-8\"")
                .post(RequestBody.create(body, MediaType.parse("text/xml; charset=\"utf-8\"")))
                .build();
        try (Response res = HTTP.newCall(req).execute()) {
            if (!res.isSuccessful()) {
                throw new IllegalStateException("HTTP " + res.code());
            }
        }
    }

    private String didl(String title, String url) {
        String t = title == null || title.isEmpty() ? "视频" : title;
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                + "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                + "<item id=\"0\" parentID=\"-1\" restricted=\"1\">"
                + "<dc:title>" + xmlEscape(t) + "</dc:title>"
                + "<upnp:class>object.item.videoItem</upnp:class>"
                + "<res protocolInfo=\"http-get:*:video/*:*\">" + xmlEscape(url) + "</res>"
                + "</item></DIDL-Lite>";
    }

    private String xmlEscape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
