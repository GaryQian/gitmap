<?php

namespace Tests;

use App\Models\Customer;
use App\Services\OrderService;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Tests\Fakes\FakeGateway;

final class OrderServiceTest extends TestCase
{
    public function testPlacingAnOrderChargesTheGateway(): void
    {
        $gateway = new FakeGateway();
        $service = new OrderService($gateway, new NullLogger());

        $order = $service->place(new Customer('ada@example.com', 'Ada'), [['price' => 250, 'qty' => 2]]);

        $this->assertSame(500, $order->total());
        $this->assertSame([['ada@example.com', 500]], $gateway->charges);
    }

    public function testControllerStubIsOnlyText(): void
    {
        $stub = <<<'PHP'
        <?php
        use App\Http\Controllers\OrderController;
        require_once __DIR__ . '/../bootstrap/app.php';
        PHP;

        $this->assertStringContainsString('OrderController', $stub);
    }
}
