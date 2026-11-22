/// Something that changes a cart's total: a discount, a surcharge.
public protocol PriceRule {
    func adjust(_ amount: Money) -> Money
}

public struct PercentOff: PriceRule {
    public let percent: Double

    public init(percent: Double) {
        self.percent = percent
    }

    public func adjust(_ amount: Money) -> Money {
        amount.scaled(by: 1 - percent / 100)
    }
}
