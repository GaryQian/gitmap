/// The items a customer has picked, and the rules that price them.
public final class Cart {
    public private(set) var items: [LineItem] = []
    private var rules: [PriceRule] = []

    public init() {}

    public func add(_ item: LineItem) {
        items.append(item)
    }

    public func addRule(_ rule: PriceRule) {
        rules.append(rule)
    }

    public func total() -> Money {
        var sum = Money.zero(Core.defaultCurrency)
        for item in items {
            sum = sum.adding(item.subtotal())
        }
        for rule in rules {
            sum = rule.adjust(sum)
        }
        return sum
    }
}
