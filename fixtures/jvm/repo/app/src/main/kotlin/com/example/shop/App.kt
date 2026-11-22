package com.example.shop

import com.example.shop.analytics.SalesReport
import com.example.shop.model.LineItem
import com.example.shop.model.Order
import com.example.shop.model.OrderStatus as Status
import com.example.shop.money.Money
import com.example.shop.service.CheckoutService
import com.example.shop.service.PaymentResult.Declined
import kotlinx.coroutines.runBlocking

/*
 * Entry point. Not an import:
 * import com.example.shop.util.slugify
 */
fun main() = runBlocking {
    val order = Order("A-1")
    order.add(LineItem("tea", 2, Money.of("4.50")))
    val result = CheckoutService().checkout(order)
    if (result is Declined || order.status() != Status.PAID) {
        println("declined")
        return@runBlocking
    }
    println(SalesReport(listOf(order)).summary())
}
