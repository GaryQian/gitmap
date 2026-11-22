import 'package:flutter/material.dart';
import 'package:shop_app/src/cart_page.dart';
import 'package:shop_core/shop_core.dart' show Cart;

void main() => runApp(const ShopApp());

class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Shop',
      theme: ThemeData.dark(),
      home: CartPage(cart: Cart()),
    );
  }
}
