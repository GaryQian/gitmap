package com.example.shop.service;

import static com.example.shop.money.Currencies.percent;
import static java.util.Objects.requireNonNull;

import com.example.shop.model.*;
import com.example.shop.money.Money;
import java.math.BigDecimal;

/** Prices an order: subtotal plus tax. */
public class PricingService implements Pricer {
    private final int taxPercent;

    public PricingService(int taxPercent) {
        this.taxPercent = taxPercent;
    }

    @Override
    public Money price(Order order) {
        requireNonNull(order, "order");
        Money subtotal = order.subtotal();
        BigDecimal tax = percent(subtotal.amount(), taxPercent);
        return subtotal.plus(Money.of(tax.toPlainString()));
    }

    public boolean isBillable(Order order) {
        return order.status() == OrderStatus.OPEN && !order.items().isEmpty();
    }
}
