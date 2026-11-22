<?php

declare(strict_types=1);

use App\Services\{OrderService, StripeGateway as Gateway};
use Psr\Log\NullLogger;

require_once __DIR__ . '/../src/Support/helpers.php';
// require_once __DIR__ . '/../src/Models/Customer.php';  (autoloaded now)

$gateway = new Gateway(getenv('STRIPE_KEY') ?: 'test');

return [
    'orders' => new OrderService($gateway, new NullLogger()),
];
