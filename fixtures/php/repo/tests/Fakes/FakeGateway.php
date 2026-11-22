<?php

namespace Tests\Fakes;

use App\Services\PaymentGateway;

final class FakeGateway implements PaymentGateway
{
    /** @var array<int, array{string, int}> */
    public array $charges = [];

    public function charge(string $account, int $cents): bool
    {
        $this->charges[] = [$account, $cents];

        return true;
    }
}
