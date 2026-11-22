part of shop_core.pricing;

/// A rule that lowers a cart total.
abstract class Discount {
  const Discount();

  int apply(int totalCents, int itemCount);
}

/// Ten percent off from the tenth item.
class BulkDiscount extends Discount {
  const BulkDiscount({this.threshold = 10});

  final int threshold;

  @override
  int apply(int totalCents, int itemCount) {
    if (itemCount < threshold) return totalCents;
    return roundToCents(totalCents * 0.9);
  }
}

int applyDiscounts(int totalCents, int itemCount, [List<Discount> discounts = const [BulkDiscount()]]) {
  var total = totalCents;
  for (final discount in discounts) {
    total = discount.apply(total, itemCount);
  }
  return math.max(total, 0);
}
