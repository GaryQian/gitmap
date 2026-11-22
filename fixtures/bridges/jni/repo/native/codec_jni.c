#include <jni.h>

JNIEXPORT jboolean JNICALL Java_com_example_media_Codec_init(JNIEnv *env, jobject thiz) {
    return JNI_TRUE;
}

JNIEXPORT jint JNICALL Java_com_example_media_Codec_configure(JNIEnv *env, jobject thiz, jobject option) {
    return 0;
}

/* @JvmStatic in a companion: a static method of Codec itself. */
JNIEXPORT jint JNICALL Java_com_example_media_Codec_version(JNIEnv *env, jclass clazz) {
    return 3;
}

/* Without @JvmStatic: a method of Codec.Companion. */
JNIEXPORT jint JNICALL Java_com_example_media_Codec_00024Companion_probe(JNIEnv *env, jobject companion) {
    return 1;
}

JNIEXPORT jint JNICALL Java_com_example_media_Codec_00024Registry_size(JNIEnv *env, jobject registry) {
    return 0;
}
