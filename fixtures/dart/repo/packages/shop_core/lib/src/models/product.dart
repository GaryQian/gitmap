import 'package:meta/meta.dart';

/// How a product is taxed.
enum TaxClass { standard, reduced, exempt }

typedef ProductId = String;

/// Something that can print itself on a receipt.
mixin Describable {
  String get label;

  String describe() => '<$label>';
}

@immutable
class Product with Describable {
  const Product({
    required this.id,
    required this.name,
    required this.priceCents,
    this.taxClass = TaxClass.standard,
  });

  factory Product.fromJson(Map<String, Object?> json) {
    return Product(
      id: json['id']! as ProductId,
      name: json['name']! as String,
      priceCents: json['priceCents']! as int,
      taxClass: TaxClass.values.byName(json['taxClass'] as String? ?? 'standard'),
    );
  }

  final ProductId id;
  final String name;
  final int priceCents;
  final TaxClass taxClass;

  bool get isTaxed => taxClass != TaxClass.exempt;

  @override
  String get label => name;

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'priceCents': priceCents,
        'taxClass': taxClass.name,
      };
}

extension ProductListTotals on List<Product> {
  int get netCents => fold(0, (sum, product) => sum + product.priceCents);
}
