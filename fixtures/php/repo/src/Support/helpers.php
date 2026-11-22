<?php

namespace App\Support;

const CURRENCY = 'USD';

/** Formats an amount in cents for display. */
function money(int $cents): string
{
    return sprintf('%s %0.2f', CURRENCY, $cents / 100);
}
