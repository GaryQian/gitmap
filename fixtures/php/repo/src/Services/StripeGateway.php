<?php

namespace App\Services;

final class StripeGateway implements PaymentGateway
{
    public function __construct(private string $apiKey)
    {
    }

    public function charge(string $account, int $cents): bool
    {
        // A real client would call the API here; the fixture only needs a use of the key.
        return $cents > 0 && $this->apiKey !== '';
    }
}
