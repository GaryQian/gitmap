<?php

namespace App\Services;

interface PaymentGateway
{
    /** Charges the account and reports whether the payment went through. */
    public function charge(string $account, int $cents): bool;
}
