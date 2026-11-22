/// One row of a cart: a product and how many of it.
public struct LineItem {
    public let name: String
    public let unitPrice: Money
    public let quantity: Int

    public init(name: String, unitPrice: Money, quantity: Int = 1) {
        self.name = name
        self.unitPrice = unitPrice
        self.quantity = quantity
    }

    public func subtotal() -> Money {
        unitPrice.scaled(by: Double(quantity))
    }
}
