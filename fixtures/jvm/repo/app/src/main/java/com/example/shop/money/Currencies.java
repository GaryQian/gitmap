package com.example.shop.money;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Rounding rules shared by everything that handles money. */
public final class Currencies {
    public static final int SCALE = 2;

    private Currencies() {
    }

    public static BigDecimal round(BigDecimal value) {
        return value.setScale(SCALE, RoundingMode.HALF_EVEN);
    }

    public static BigDecimal percent(BigDecimal value, int percent) {
        return round(value.multiply(BigDecimal.valueOf(percent)).divide(BigDecimal.valueOf(100)));
    }
}
