package com.example.shop;

import com.example.billing.InvoiceItemsOuterClass.InvoiceItems;
import java.util.List;

public final class Sync {
    public List<String> skus(InvoiceItems items) {
        return items.getSkuList();
    }
}
