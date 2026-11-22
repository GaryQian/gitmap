// Calls from native code back into the JVM.
#include <jni.h>

static jclass gListenerClass;
static jmethodID gOnEvent;
static jmethodID gOnFrame;

void cacheIds(JNIEnv *env) {
    jclass local = env->FindClass("com/example/media/Listener");
    gListenerClass = static_cast<jclass>(env->NewGlobalRef(local));
    gOnEvent = env->GetMethodID(gListenerClass, "onEvent", "(I)V");

    jclass decoder = env->FindClass("com/example/media/Decoder");
    gOnFrame = env->GetMethodID(decoder, "onFrame", "(I)V");

    // Looked up, never called into: a class-level key.
    jclass stats = env->FindClass("com/example/media/Decoder$Stats");
    (void) stats;

    // Not in this repo: no edge.
    jclass string = env->FindClass("java/lang/String");
    (void) string;
    // env->FindClass("com/example/media/Player") in a comment is not a lookup.
}
