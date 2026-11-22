import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shop_core/shop_core.dart' show Cart, CartLine, openStorage;

import 'widgets/price_tag.dart';

typedef LineBuilder = Widget Function(BuildContext context, CartLine line);

class CartPage extends StatefulWidget {
  const CartPage({super.key, required this.cart});

  final Cart cart;

  @override
  State<CartPage> createState() => _CartPageState();
}

class _CartPageState extends State<CartPage> with SingleTickerProviderStateMixin implements Listenable {
  final _storage = openStorage();

  Future<void> _checkout() async {
    await _storage.save(widget.cart);
    setState(widget.cart.clear);
  }

  Widget _buildLine(BuildContext context, CartLine line) {
    return ListTile(
      title: Text(line.product.name),
      trailing: PriceTag(cents: line.totalCents),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lines = widget.cart.lines;
    return Scaffold(
      appBar: AppBar(title: const Text('Cart')),
      body: ListView.builder(
        itemCount: lines.length,
        itemBuilder: (context, index) => _buildLine(context, lines[index]),
      ),
      bottomNavigationBar: PriceTag(cents: widget.cart.totalCents, emphasised: true),
      floatingActionButton: FloatingActionButton(onPressed: _checkout, child: const Icon(Icons.check)),
    );
  }
}
