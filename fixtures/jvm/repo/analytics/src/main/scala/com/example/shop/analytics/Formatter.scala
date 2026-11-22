package com.example.shop.analytics

/** Renders report lines. */
trait Formatter {
  def line(label: String, value: Any): String = s"${Formatter.pad(label)} $value"
}

object Formatter {
  val Width = 12

  def pad(text: String): String = text.padTo(Width, ' ')
}
