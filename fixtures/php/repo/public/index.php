<?php

declare(strict_types=1);

use App\Http\Controllers\OrderController;
use Illuminate\Http\Request;

$services = require_once __DIR__ . '/../bootstrap/app.php';

$controller = new OrderController($services['orders']);
$response = $controller->store(Request::capture());
?>
<!DOCTYPE html>
<html>
  <body>
    <p>Please use the form below; it doesn't require an account.</p>
    <pre><?= htmlspecialchars(json_encode($response)) ?></pre>
  </body>
</html>
