package com.example.shop.service;

import com.example.shop.model.Order;
import com.example.shop.money.Money;

/** Works out what an order costs. */
public interface Pricer {
    Money price(Order order);
}
