import 'package:collection/collection.dart';

import '../pricing.dart';
import 'product.dart';

part 'cart_line.dart';

/// A shopping cart: products and how many of each.
class Cart {
  final List<CartLine> _lines = [];

  List<CartLine> get lines => List.unmodifiable(_lines);

  int get itemCount => _lines.fold(0, (count, line) => count + line.quantity);

  void add(Product product, {int quantity = 1}) {
    final existing = _lines.firstWhereOrNull((line) => line.product.id == product.id);
    if (existing != null) {
      existing.quantity += quantity;
    } else {
      _lines.add(CartLine(product, quantity));
    }
  }

  void clear() => _lines.clear();

  /// What the customer pays, tax and discounts included.
  int get totalCents {
    var sum = 0;
    for (final line in _lines) {
      sum += lineTotal(line.product, line.quantity);
    }
    return applyDiscounts(sum, itemCount);
  }
}
