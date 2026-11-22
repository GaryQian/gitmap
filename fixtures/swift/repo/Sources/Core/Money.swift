import Foundation

/// An amount in the minor units of one currency.
public struct Money: Equatable {
    public let cents: Int
    public let currency: Currency

    /// Shown by `shop --help`. The import below is text, not code.
    static let usage = """
        import Core
        let price = Money(cents: 499)
        """

    public init(cents: Int, currency: Currency = Core.defaultCurrency) {
        self.cents = cents
        self.currency = currency
    }

    public static func zero(_ currency: Currency) -> Money {
        Money(cents: 0, currency: currency)
    }

    public func adding(_ other: Money) -> Money {
        Money(cents: cents + other.cents, currency: currency)
    }

    public func scaled(by factor: Double) -> Money {
        Money(cents: Int((Double(cents) * factor).rounded()), currency: currency)
    }

    public func formatted() -> String {
        let units = String(format: "%.2f", Double(cents) / 100)
        return "\(currency.symbol())\(units)"
    }
}
