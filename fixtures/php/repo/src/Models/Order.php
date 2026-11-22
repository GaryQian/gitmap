<?php

namespace App\Models;

use function App\Support\money;

class Order
{
    use HasTimestamps;

    public string $id;

    /** @param array<int, array{price: int, qty: int}> $items */
    private function __construct(public Customer $customer, private array $items)
    {
        $this->id = uniqid('order_');
        $this->touch();
    }

    public static function create(Customer $customer, array $items): self
    {
        return new self($customer, $items);
    }

    public function total(): int
    {
        return array_sum(array_map(fn (array $item): int => $item['price'] * $item['qty'], $this->items));
    }

    public function formattedTotal(): string
    {
        return money($this->total());
    }
}
