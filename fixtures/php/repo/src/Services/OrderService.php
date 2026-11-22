<?php

namespace App\Services;

use App\Models\{Order, Customer as Buyer};
use Psr\Log\LoggerInterface;
use RuntimeException;

class OrderService
{
    public function __construct(private PaymentGateway $gateway, private LoggerInterface $logger)
    {
    }

    public function place(Buyer $buyer, array $items): Order
    {
        $order = Order::create($buyer, $items);
        $notify = function (string $event) use ($order): void {
            $this->logger->info($event, ['order' => $order->id]);
        };

        if (!$this->gateway->charge($buyer->email, $order->total())) {
            throw new RuntimeException('Payment declined');
        }
        $notify('order.placed');

        return $order;
    }
}
