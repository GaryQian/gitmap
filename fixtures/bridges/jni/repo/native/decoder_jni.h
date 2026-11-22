// Prototypes only (as javac -h writes them): a declaration is not an implementation.
#ifndef DECODER_JNI_H
#define DECODER_JNI_H

#include <jni.h>

#ifdef __cplusplus
extern "C" {
#endif

JNIEXPORT jlong JNICALL Java_com_example_media_Decoder_open(JNIEnv *, jobject, jstring);
JNIEXPORT void JNICALL Java_com_example_media_Decoder_close(JNIEnv *, jclass, jlong);
JNIEXPORT jint JNICALL Java_com_example_media_Decoder_read___3B(JNIEnv *, jobject, jbyteArray);
JNIEXPORT jint JNICALL Java_com_example_media_Decoder_read___3BII(JNIEnv *, jobject, jbyteArray, jint, jint);
JNIEXPORT jint JNICALL Java_com_example_media_Decoder_00024Stats_count(JNIEnv *, jobject);

#ifdef __cplusplus
}
#endif

#endif
