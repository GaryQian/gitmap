package com.example.media

/* A block comment /* nested */ with: external fun notAFunction() */
class Codec(private val name: String = "{default}") {
    external fun init(): Boolean

    private external fun <T> configure(option: T): Int

    fun describe(): String = "external fun inAString() $name"

    companion object {
        @JvmStatic
        external fun version(): Int

        external fun probe(): Int
    }

    object Registry {
        external fun size(): Int
    }
}

external fun nativeLog(message: String)

fun log(message: String) = nativeLog(message)
