<?php

namespace App\Models;

class Customer
{
    use HasTimestamps;

    public function __construct(public string $email, public string $name)
    {
        $this->touch();
    }
}
