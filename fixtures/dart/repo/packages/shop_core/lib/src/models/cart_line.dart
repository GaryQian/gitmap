part of 'cart.dart';

/// One product in a cart, with its quantity.
class CartLine {
  CartLine(this.product, this.quantity);

  final Product product;
  int quantity;

  int get totalCents => lineTotal(product, quantity);
}
