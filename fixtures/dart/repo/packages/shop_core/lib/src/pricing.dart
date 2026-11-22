/// Prices, tax and discounts, in whole cents.
library shop_core.pricing;

import 'dart:math' as math;

import 'package:shop_core/src/models/product.dart';

part 'discounts.dart';

/// Shown in the README. It is text, not an import of this library.
const String usage = '''
import 'package:shop_core/src/models/cart.dart';

final total = lineTotal(product, 2);
''';

const Map<TaxClass, double> _taxRates = {
  TaxClass.standard: 0.2,
  TaxClass.reduced: 0.07,
  TaxClass.exempt: 0,
};

int roundToCents(double amount) => amount.round();

double taxRate(TaxClass taxClass) => _taxRates[taxClass] ?? 0;

/// Price of [quantity] units of [product], tax included.
int lineTotal(Product product, int quantity) {
  final net = product.priceCents * math.max(quantity, 0);
  return net + roundToCents(net * taxRate(product.taxClass));
}

String formatPrice(int cents, {String symbol = r'$'}) {
  final whole = cents ~/ 100;
  final fraction = (cents % 100).toString().padLeft(2, '0');
  return '$symbol$whole.$fraction';
}
