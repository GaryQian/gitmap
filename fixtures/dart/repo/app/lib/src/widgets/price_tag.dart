import 'package:flutter/widgets.dart';
import 'package:shop_core/src/pricing.dart' as pricing;

/// A price, formatted the same way everywhere in the app.
class PriceTag extends StatelessWidget {
  const PriceTag({super.key, required this.cents, this.emphasised = false});

  final int cents;
  final bool emphasised;

  @override
  Widget build(BuildContext context) {
    final style = emphasised ? const TextStyle(fontWeight: FontWeight.bold) : null;
    return Text(pricing.formatPrice(cents), style: style);
  }
}
