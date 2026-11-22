package com.example.shop.service

import com.example.shop.money.Money
import java.util.Formatter

typealias ReceiptId = String

/** What the customer gets after paying. */
data class Receipt(val id: ReceiptId, val total: Money) {
    fun render(): String {
        val out = Formatter()
        out.format("%s: %s", id, total)
        return out.toString()
    }
}

interface ReceiptSource {
    fun receiptFor(order: com.example.shop.model.Order): Receipt
}

sealed interface PaymentResult {
    data class Paid(val receipt: Receipt) : PaymentResult
    data class Declined(val reason: String) : PaymentResult
}
