package com.example.shop.money;

import java.math.BigDecimal;

/** An amount in the shop's single currency. */
public final class Money implements Comparable<Money> {
    private final BigDecimal amount;

    private Money(BigDecimal amount) {
        this.amount = amount;
    }

    public static Money zero() {
        return new Money(BigDecimal.ZERO);
    }

    public static Money of(String amount) {
        return new Money(Currencies.round(new BigDecimal(amount)));
    }

    public Money plus(Money other) {
        return new Money(amount.add(other.amount));
    }

    public Money times(int factor) {
        return new Money(Currencies.round(amount.multiply(BigDecimal.valueOf(factor))));
    }

    public BigDecimal amount() {
        return amount;
    }

    @Override
    public int compareTo(Money other) {
        return amount.compareTo(other.amount);
    }

    @Override
    public String toString() {
        // not a call: format(amount)
        return "Money.of(" + amount + ")";
    }
}
