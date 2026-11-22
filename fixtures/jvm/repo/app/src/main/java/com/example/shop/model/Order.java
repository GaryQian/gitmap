package com.example.shop.model;

import com.example.shop.money.Money;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A customer's order: line items plus a status. */
public class Order {
    private final String id;
    private final List<LineItem> items = new ArrayList<>();
    private OrderStatus status = OrderStatus.OPEN;

    public Order(String id) {
        this.id = id;
    }

    public String id() {
        return id;
    }

    public void add(LineItem item) {
        items.add(item);
    }

    public List<LineItem> items() {
        return Collections.unmodifiableList(items);
    }

    /** Sum of all line totals. */
    public Money subtotal() {
        Money sum = Money.zero();
        for (LineItem item : items) {
            sum = sum.plus(item.total());
        }
        return sum;
    }

    public OrderStatus status() {
        return status;
    }

    public void markPaid() {
        status = OrderStatus.PAID;
    }
}
