import Core

/// A line item priced in whole dollars, for tests that do not care about the details.
func sampleItem(dollars: Int, quantity: Int = 1) -> LineItem {
    LineItem(name: "Sample", unitPrice: Money(cents: dollars * 100), quantity: quantity)
}
