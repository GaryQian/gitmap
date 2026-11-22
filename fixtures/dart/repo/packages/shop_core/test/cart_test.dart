import 'package:shop_core/shop_core.dart';
import 'package:test/test.dart';

void main() {
  const tea = Product(id: 'tea', name: 'Green tea', priceCents: 450, taxClass: TaxClass.reduced);

  test('a cart totals its lines with tax', () {
    final cart = Cart()..add(tea, quantity: 2);
    expect(cart.itemCount, 2);
    expect(cart.totalCents, 963);
    expect(formatPrice(cart.totalCents), r'$9.63');
  });
}
