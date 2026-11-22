<?php

namespace App\Http\Controllers;

abstract class Controller
{
    protected function json(array $data, int $status = 200): array
    {
        return ['status' => $status, 'body' => $data];
    }
}
