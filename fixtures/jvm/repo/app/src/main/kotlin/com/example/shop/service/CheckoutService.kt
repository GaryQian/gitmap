package com.example.shop.service

import com.example.shop.model.Order
import com.example.shop.money.Money
import com.example.shop.util.slugify
import kotlinx.coroutines.delay

/** Takes an order through pricing and payment. */
class CheckoutService(
    private val pricer: Pricer = PricingService(TAX_PERCENT),
) : ReceiptSource {

    override fun receiptFor(order: Order): Receipt {
        val total: Money = pricer.price(order)
        return Receipt(slugify(order.id()), total)
    }

    suspend fun checkout(order: Order): PaymentResult {
        if (order.items().isEmpty()) return PaymentResult.Declined("empty order")
        delay(10)
        order.markPaid()
        log("paid ${order.id()}")
        return PaymentResult.Paid(receiptFor(order))
    }

    private fun log(message: String) {
        println("checkout: $message // not a comment: import com.example.shop.analytics.Formatter")
    }

    companion object {
        const val TAX_PERCENT = 20
    }
}
