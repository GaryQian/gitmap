#include "decoder_jni.h"

#include <string>

// Not a function: Java_com_example_media_Ghost_haunt(JNIEnv *, jobject) {}
static const char *kDoc = "Java_com_example_media_Ghost_rattle(JNIEnv *, jobject) {";

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_example_media_Decoder_open(JNIEnv *env, jobject thiz, jstring path)
{
    const char *chars = env->GetStringUTFChars(path, nullptr);
    std::string copy(chars);
    env->ReleaseStringUTFChars(path, chars);
    return static_cast<jlong>(copy.size());
}

JNIEXPORT void JNICALL Java_com_example_media_Decoder_close(JNIEnv *, jclass, jlong handle) {
    (void) handle;
}

JNIEXPORT jint JNICALL Java_com_example_media_Decoder_read___3B(JNIEnv *env, jobject thiz, jbyteArray buffer) {
    // The longer overload does the work.
    return Java_com_example_media_Decoder_read___3BII(env, thiz, buffer, 0, env->GetArrayLength(buffer));
}

JNIEXPORT jint JNICALL Java_com_example_media_Decoder_read___3BII(JNIEnv *, jobject, jbyteArray, jint offset, jint length) {
    return length - offset;
}

JNIEXPORT jint JNICALL Java_com_example_media_Decoder_00024Stats_count(JNIEnv *, jobject) {
    return 0;
}

}  // extern "C"
