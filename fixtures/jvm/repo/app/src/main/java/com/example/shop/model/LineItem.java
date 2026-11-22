package com.example.shop.model;

import com.example.shop.money.Money;

/** One product line of an order. */
public record LineItem(String sku, int quantity, Money unitPrice) {
    public Money total() {
        return unitPrice.times(quantity);
    }
}
