package com.example.media;

/** Called back from the decoder thread. */
public interface Listener {
    void onEvent(int code);
}
