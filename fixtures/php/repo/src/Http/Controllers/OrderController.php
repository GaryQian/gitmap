<?php

namespace App\Http\Controllers;

use App\Models\Customer;
use App\Services\OrderService;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function __construct(private OrderService $orders)
    {
    }

    public function store(Request $request): array
    {
        $customer = new Customer($request->input('email'), $request->input('name'));
        $order = $this->orders->place($customer, (array) $request->input('items', []));

        return $this->json(['id' => $order->id, 'total' => $order->formattedTotal()], 201);
    }
}
