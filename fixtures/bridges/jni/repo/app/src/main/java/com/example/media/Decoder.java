package com.example.media;

/**
 * Decodes media through the native library.
 * A comment must not count: private native void notAMethod();
 */
public class Decoder {
    static {
        System.loadLibrary("media");
    }

    private static final String HINT = "public native void alsoNotAMethod();";
    private static final char BRACE = '{';

    private long handle;

    public native long open(String path);

    private static native void close(long handle);

    // Overloaded: the C names carry the argument signature.
    public native int read(byte[] buffer);

    public native int read(byte[] buffer, int offset, int length);

    public void onFrame(int index) {
        Runnable r = new Runnable() {
            @Override public void run() { handle++; }
        };
        r.run();
    }

    public static class Stats {
        public native int count();
    }
}
