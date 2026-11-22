// Natives bound at load time with RegisterNatives instead of by mangled name.
#include <jni.h>

namespace {

void nativeLog(JNIEnv *env, jclass, jstring message) {}
void playerStart(JNIEnv *env, jobject, jlong handle) {}
void playerStop(JNIEnv *env, jobject, jlong handle) {}

const JNINativeMethod kLogMethods[] = {
    {"nativeLog", "(Ljava/lang/String;)V", reinterpret_cast<void *>(nativeLog)},
};

const JNINativeMethod kPlayerMethods[] = {
    { const_cast<char *>("nativeStart"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(playerStart) },
    { const_cast<char *>("nativeStop"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(playerStop) },
};

const char *const kPlayerClass = "com/example/media/Player";

}  // namespace

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    JNIEnv *env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;

    jclass clazz = env->FindClass("com/example/media/CodecKt");
    if (clazz == nullptr) return JNI_ERR;
    if (env->RegisterNatives(clazz, kLogMethods, 1) != JNI_OK) return JNI_ERR;

    clazz = env->FindClass(kPlayerClass);
    if (env->RegisterNatives(clazz, kPlayerMethods, sizeof(kPlayerMethods) / sizeof(kPlayerMethods[0])) != JNI_OK) {
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}
