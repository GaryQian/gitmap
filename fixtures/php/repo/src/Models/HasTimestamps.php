<?php

namespace App\Models;

use DateTimeImmutable;

trait HasTimestamps
{
    public ?DateTimeImmutable $updatedAt = null;

    public function touch(): void
    {
        $this->updatedAt = new DateTimeImmutable();
    }
}
