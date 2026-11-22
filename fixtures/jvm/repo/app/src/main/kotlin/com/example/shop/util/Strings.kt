package com.example.shop.util

private val NON_WORD = Regex("[^a-z0-9]+")

/** Lower-case, dash-separated form of a label. */
fun slugify(label: String): String = collapse(label.lowercase()).trim('-')

fun String.initials(): String = split(' ').mapNotNull { it.firstOrNull() }.joinToString("")

private fun collapse(text: String): String = NON_WORD.replace(text, "-")
