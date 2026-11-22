package com.example.media;

public final class Player {
    private native void nativeStart(long handle);

    private native void nativeStop(long handle);

    public void start() {
        nativeStart(0L);
    }
}
