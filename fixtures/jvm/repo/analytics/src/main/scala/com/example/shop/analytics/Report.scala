package com.example.shop.analytics

import com.example.shop.model.{
  Order,
  LineItem => Item
}
import com.example.shop.money._
import scala.collection.mutable

trait Reporter {
  def summary(): String
}

/** Totals a batch of orders. */
class SalesReport(orders: Seq[Order]) extends Reporter with Formatter {
  private val bySku = mutable.Map.empty[String, Int]

  private def count(item: Item): Unit =
    bySku.update(item.sku(), bySku.getOrElse(item.sku(), 0) + item.quantity())

  def total: Money = orders.map(_.subtotal()).foldLeft(Money.zero())(_ plus _)

  override def summary(): String = {
    orders.foreach(o => o.items().forEach(item => count(item)))
    line("total", Currencies.round(total.amount()))
  }
}
