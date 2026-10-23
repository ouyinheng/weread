package com.weread.app;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Java port of the edge-tts v2 Sec-MS-GEC token.
 *
 * The public read-aloud endpoint moved from a plain SHA-256 of the time bucket
 * to a two-part digest: an 8-byte CS64 word pair and a 64-byte custom SHA-256.
 * Both are salted with the trusted client token and truncated once at the end,
 * so this cannot be replaced by {@link java.security.MessageDigest}. The port
 * is verified value-for-value against the Python implementation for fixed
 * timestamps, which is the only way to keep the online voices working.
 */
final class EdgeDrm {

    private static final long M = 0xFFFFFFFFL;
    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final double WIN_EPOCH = 11644473600.0;

    private static final long[] INITIAL = {
            0x6A09E667L, 0xBB67AE85L, 0x3C6EF372L, 0xA54FF53AL,
            0x510E527FL, 0x9B05688CL, 0x1F83D9ABL, 0x5BE0CD19L,
    };
    private static final long[] STATE = {
            0xFD9FBEA2L, 0x91243CE7L, 0xBE499094L, 0xCD2E1E0AL,
            0x6C006F49L, 0x04BD35ABL, 0xFEB0A7E4L, 0x03EFFBD2L,
    };
    private static final long[] SCHEDULE = {
            0xEB24BF9EL, 0x1558691FL, 0xA0C09EE2L, 0x0CFA32BAL,
            0xA622EE8CL, 0xD1DD9491L, 0xC0DD25A0L, 0xF9E70AB6L,
            0xF0C31573L, 0x7058CE4EL, 0x7188E606L, 0x00E5AB33L,
            0xD258B060L, 0x72766564L,
    };
    private static final long[] ROUND = {
            0x428A2F98L, 0x71374491L, 0xB5C0FBCFL, 0xE9B5DBA5L,
            0x3956C25BL, 0x59F111F1L, 0x923F82A4L, 0xAB1C5ED5L,
            0xD807AA98L, 0x12835B01L, 0x243185BEL, 0x550C7DC3L,
            0x72BE5D74L, 0x80DEB1FEL, 0x9BDC06A7L, 0xC19BF174L,
            0xE49B69C1L, 0xEFBE4786L, 0x0FC19DC6L, 0x240CA1CCL,
            0x2DE92C6FL, 0x4A7484AAL, 0x5CB0A9DCL, 0x76F988DAL,
            0x983E5152L, 0xA831C66DL, 0xB00327C8L, 0xBF597FC7L,
            0xC6E00BF3L, 0xD5A79147L, 0x06CA6351L, 0x14292967L,
            0x27B70A85L, 0x2E1B2138L, 0x4D2C6DFCL, 0x53380D13L,
            0x650A7354L, 0x766A0ABBL, 0x81C2C92EL, 0x92722C85L,
            0xA2BFE8A1L, 0xA81A664BL, 0xC24B8B70L, 0xC76C51A3L,
            0xD192E819L, 0xD6990624L, 0xF40E3585L, 0x106AA070L,
            0x19A4C116L, 0x1E376C08L, 0x2748774CL, 0x34B0BCB5L,
            0x391C0CB3L, 0x4ED8AA4AL, 0x5B9CCA4FL, 0x682E6FF3L,
            0x748F82EEL, 0x78A5636FL, 0x84C87814L, 0x8CC70208L,
            0x90BEFFFAL, 0xA4506CEBL, 0xBEF9A3F7L, 0xC67178F2L,
    };
    private static final long ADJ = 0xC9DC06A7L;
    private static final long SIGMA0_ADJ = 0x059C0B80L;
    private static final long SIGMA1_ADJ = 0x000B92C0L;
    private static final long[] BLOCK = new long[64];

    private static final long[] CS_COEFF = {
            0xE82E91B1L, 0x44DE24C6L, 0x3BEB65BCL, 0xC89C5933L,
            0x8D1EC211L, 0x314EF5D5L, 0xE92491B1L, 0xF0A5B9D5L,
            0x06064CF3L, 0xDA79FA60L, 0xBED20560L, 0x89F9C9F8L,
            0x35FA38C6L, 0xCB49E3C6L,
    };
    private static final long[] CS_OFFSET = {
            0xB32700D0L, 0x88DFF51DL, 0x29514038L, 0xB328CBDFL,
            0xD405B4D5L, 0x26E55F3CL, 0x607801C6L, 0x82B2C1FBL,
            0xFA51A3DAL, 0x207CC464L, 0x3C3C74F3L, 0xD2D14B61L,
            0xBB04A2C1L, 0xC5626167L,
    };
    private static final long CS_FACTOR = 0x82893933L;
    private static final long CS_ADJ0 = 0xF2F90B1AL;
    private static final long CS_ADJ1 = 0x0B1A0000L;

    static {
        System.arraycopy(ROUND, 0, BLOCK, 0, 14);
        BLOCK[14] = ADJ;
        System.arraycopy(ROUND, 15, BLOCK, 15, 49);
    }

    private EdgeDrm() {}

    static String generateSecMsGec() {
        return generateSecMsGecV2(null);
    }

    static String generateSecMsGecV2(Double unixTimestamp) {
        double ticks = unixTimestamp == null
                ? System.currentTimeMillis() / 1000.0
                : unixTimestamp;
        ticks += WIN_EPOCH;
        ticks -= ticks % 300.0;
        ticks *= 1e7;
        String strToHash = String.format(Locale.ROOT, "%.0f", ticks) + TRUSTED_CLIENT_TOKEN;
        String[] hash = tokenHash(strToHash.getBytes(StandardCharsets.US_ASCII));
        return hash[0] + "-" + hash[1];
    }

    private static long rol16(long v) {
        v &= M;
        return ((v << 16) | (v >>> 16)) & M;
    }

    private static long sigma0(long v) {
        return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) & M;
    }

    private static long sigma1(long v) {
        return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) & M;
    }

    private static long[] sha256Rounds(long[] state, long[] words, int firstRound) {
        long a = state[0], b = state[1], c = state[2], d = state[3];
        long e = state[4], f = state[5], g = state[6], h = state[7];
        long[] constants = firstRound == 14 ? BLOCK : ROUND;
        int aligned = Math.min(64, ((firstRound + 7) / 8) * 8);

        for (int index = firstRound; index < aligned; index++) {
            long rotE = e * 0x100000001L;
            long rotA = a * 0x100000001L;
            long t1 = h
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (g ^ (e & (f ^ g)))
                    + constants[index]
                    + words[index];
            long t2 = ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((a & b) | (c & (a | b)));
            long newA = (t1 + t2) & M;
            long newE = (d + t1) & M;
            long oldA = a, oldB = b, oldC = c, oldE = e, oldF = f, oldG = g;
            a = newA;
            b = oldA;
            c = oldB;
            d = oldC;
            e = newE;
            f = oldE;
            g = oldF;
            h = oldG;
        }

        for (int index = aligned; index < 64; index += 8) {
            long rotE = e * 0x100000001L;
            long rotA = a * 0x100000001L;
            long t1 = h
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (g ^ (e & (f ^ g)))
                    + constants[index]
                    + words[index];
            d = (d + t1) & M;
            h = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((a & b) | (c & (a | b)))) & M;

            rotE = d * 0x100000001L;
            rotA = h * 0x100000001L;
            t1 = g
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (f ^ (d & (e ^ f)))
                    + constants[index + 1]
                    + words[index + 1];
            c = (c + t1) & M;
            g = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((h & a) | (b & (h | a)))) & M;

            rotE = c * 0x100000001L;
            rotA = g * 0x100000001L;
            t1 = f
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (e ^ (c & (d ^ e)))
                    + constants[index + 2]
                    + words[index + 2];
            b = (b + t1) & M;
            f = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((g & h) | (a & (g | h)))) & M;

            rotE = b * 0x100000001L;
            rotA = f * 0x100000001L;
            t1 = e
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (d ^ (b & (c ^ d)))
                    + constants[index + 3]
                    + words[index + 3];
            a = (a + t1) & M;
            e = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((f & g) | (h & (f | g)))) & M;

            rotE = a * 0x100000001L;
            rotA = e * 0x100000001L;
            t1 = d
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (c ^ (a & (b ^ c)))
                    + constants[index + 4]
                    + words[index + 4];
            h = (h + t1) & M;
            d = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((e & f) | (g & (e | f)))) & M;

            rotE = h * 0x100000001L;
            rotA = d * 0x100000001L;
            t1 = c
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (b ^ (h & (a ^ b)))
                    + constants[index + 5]
                    + words[index + 5];
            g = (g + t1) & M;
            c = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((d & e) | (f & (d | e)))) & M;

            rotE = g * 0x100000001L;
            rotA = c * 0x100000001L;
            t1 = b
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (a ^ (g & (h ^ a)))
                    + constants[index + 6]
                    + words[index + 6];
            f = (f + t1) & M;
            b = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((c & d) | (e & (c | d)))) & M;

            rotE = f * 0x100000001L;
            rotA = b * 0x100000001L;
            t1 = a
                    + ((rotE >>> 6) ^ (rotE >>> 11) ^ (rotE >>> 25))
                    + (h ^ (f & (g ^ h)))
                    + constants[index + 7]
                    + words[index + 7];
            e = (e + t1) & M;
            a = (t1
                    + ((rotA >>> 2) ^ (rotA >>> 13) ^ (rotA >>> 22))
                    + ((b & c) | (d & (b | c)))) & M;
        }
        return new long[]{a, b, c, d, e, f, g, h};
    }

    private static void expandSchedule(long[] words, int firstWord) {
        for (int index = firstWord; index < 64; index++) {
            long x = words[index - 2];
            long y = words[index - 15];
            long s1 = (x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10);
            long s0 = (y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3);
            words[index] = (s1 + words[index - 7] + s0 + words[index - 16]) & M;
        }
    }

    private static long[] sha256Init(byte[] data) {
        long[] words = new long[64];
        words[14] = ((long) (data[0] & 0xFF) << 16)
                | ((long) (data[1] & 0xFF) << 8)
                | (data[2] & 0xFF);
        words[15] = ((long) (data[3] & 0xFF) << 24)
                | ((long) (data[4] & 0xFF) << 16)
                | ((long) (data[5] & 0xFF) << 8)
                | (data[6] & 0xFF);
        for (int index = 16; index < 30; index++) {
            long value = SCHEDULE[index - 16];
            if (index - 2 >= 14) {
                long s = sigma1(words[index - 2]);
                if (index == 16) s ^= SIGMA1_ADJ;
                value += s;
            }
            if (index - 7 >= 14) value += words[index - 7];
            if (index - 15 >= 14) {
                long s = sigma0(words[index - 15]);
                if (index == 29) s ^= SIGMA0_ADJ;
                value += s;
            }
            words[index] = value & M;
        }
        words[30] = (sigma1(words[28])
                + words[23]
                + sigma0(words[15])
                + words[14]
                + ADJ
                - ROUND[14]) & M;
        expandSchedule(words, 31);
        long[] working = sha256Rounds(STATE, words, 14);
        long[] out = new long[8];
        for (int i = 0; i < 8; i++) out[i] = (INITIAL[i] + working[i]) & M;
        return out;
    }

    private static byte[] sha256Digest(byte[] data) {
        int length = 57 + data.length;
        int zeroCount = ((55 - length) % 64 + 64) % 64;
        int rest = data.length - 7;
        byte[] padded = new byte[rest + 1 + zeroCount + 8];
        System.arraycopy(data, 7, padded, 0, rest);
        padded[rest] = (byte) 0x80;
        long bits = (long) length * 8L;
        for (int i = 0; i < 8; i++) {
            padded[padded.length - 1 - i] = (byte) (bits >>> (8 * i));
        }

        long[] state = sha256Init(data);
        long[] words = new long[64];
        for (int offset = 0; offset < padded.length; offset += 64) {
            for (int i = 0; i < 16; i++) {
                int p = offset + i * 4;
                words[i] = ((long) (padded[p] & 0xFF) << 24)
                        | ((long) (padded[p + 1] & 0xFF) << 16)
                        | ((long) (padded[p + 2] & 0xFF) << 8)
                        | (padded[p + 3] & 0xFF);
            }
            expandSchedule(words, 16);
            long[] working = sha256Rounds(state, words, 0);
            for (int i = 0; i < 8; i++) state[i] = (state[i] + working[i]) & M;
        }

        byte[] digest = new byte[32];
        for (int i = 0; i < 8; i++) {
            digest[i * 4] = (byte) (state[i] >>> 24);
            digest[i * 4 + 1] = (byte) (state[i] >>> 16);
            digest[i * 4 + 2] = (byte) (state[i] >>> 8);
            digest[i * 4 + 3] = (byte) state[i];
        }
        return digest;
    }

    private static long[] wordsLe4Even(byte[] data) {
        int pad = (4 - data.length % 4) % 4;
        int total = data.length + pad;
        int count = total / 4;
        if (count % 2 != 0) count++;
        long[] words = new long[count];
        for (int i = 0; i < total; i += 4) {
            long v = 0;
            for (int j = 0; j < 4 && i + j < data.length; j++) {
                v |= (long) (data[i + j] & 0xFF) << (8 * j);
            }
            words[i / 4] = v;
        }
        return words;
    }

    private static long[] cs64Digest(byte[] data, byte[] digest) {
        long keyA = ((long) (digest[0] & 0xFF)
                | ((long) (digest[1] & 0xFF) << 8)
                | ((long) (digest[2] & 0xFF) << 16)
                | ((long) (digest[3] & 0xFF) << 24)) | 1L;
        long keyB = ((long) (digest[4] & 0xFF)
                | ((long) (digest[5] & 0xFF) << 8)
                | ((long) (digest[6] & 0xFF) << 16)
                | ((long) (digest[7] & 0xFF) << 24)) | 1L;
        long[] factors = {(keyA * CS_FACTOR) & M, (keyB * CS_FACTOR) & M};

        byte[] prefixed = new byte[data.length + 1];
        System.arraycopy(data, 0, prefixed, 1, data.length);
        long[] source = wordsLe4Even(prefixed);
        int termCount = CS_COEFF.length + source.length;
        long[] terms = new long[termCount];
        long[] offsets = new long[termCount];
        for (int i = 0; i < CS_COEFF.length; i++) {
            terms[i] = (CS_COEFF[i] * factors[i % 2]) & M;
            offsets[i] = CS_OFFSET[i];
        }
        for (int i = 0; i < source.length; i++) {
            long word = source[i];
            long term = word * ((i % 2 == 0) ? keyA : keyB);
            long offset = rol16(word) * ((i % 2 == 0) ? 0xEF0569FBL : 0xC31713DBL);
            if (i == 0) {
                term += CS_ADJ0 * factors[0];
                offset += CS_ADJ1;
            }
            terms[CS_COEFF.length + i] = term & M;
            offsets[CS_COEFF.length + i] = offset & M;
        }

        long swapAcc = 0, swapLast = 0, state = 0, acc = 0;
        for (int i = 0; i < termCount; i += 2) {
            long x = terms[i], y = terms[i + 1];
            long t = rol16((offsets[i] + x) & M);
            long q = (t * 0x76F50F34L) & M;
            swapAcc = (swapAcc + ((rol16(q) * 0xC3EFEA97L + q) & M)) & M;
            t = rol16((offsets[i + 1] + y) & M);
            q = (t * 0x1881CE3CL) & M;
            swapLast = (rol16(q) * 0x35BD1EC9L + q) & M;
            swapAcc = (swapAcc + swapLast) & M;

            state = (state * keyA + x) & M;
            state = (rol16(state) * 0xCF98B111L) & M;
            state = (rol16(state) * 0x87085B9FL) & M;
            state = (rol16(state) * 0x12CEB96DL) & M;
            state = (rol16(state) * 0x257E1D83L) & M;
            acc = (acc + state) & M;
            t = (state * keyB + y) & M;
            t = (rol16(t) * 0xA27416F5L) & M;
            t = (rol16(t) * 0xD38396FFL) & M;
            state = (rol16((rol16(t) * 0x7C932B89L) & M) * 0xBFA49F69L) & M;
            acc = (acc + state) & M;
        }
        return new long[]{swapLast ^ state, swapAcc ^ acc};
    }

    private static String[] tokenHash(byte[] data) {
        byte[] digest = sha256Digest(data);
        long[] cs = cs64Digest(data, digest);
        byte[] csBytes = new byte[8];
        for (int i = 0; i < 4; i++) {
            csBytes[i] = (byte) (cs[0] >>> (8 * i));
            csBytes[4 + i] = (byte) (cs[1] >>> (8 * i));
        }
        return new String[]{hex(csBytes), hex(digest)};
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02X", b & 0xFF));
        return sb.toString();
    }
}
