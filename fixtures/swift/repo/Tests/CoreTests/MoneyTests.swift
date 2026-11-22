import XCTest
@testable import Core

final class MoneyTests: XCTestCase {
    func testAddingKeepsTheCurrency() {
        let sum = Money(cents: 150, currency: .eur).adding(Money(cents: 250, currency: .eur))
        XCTAssertEqual(sum, Money(cents: 400, currency: .eur))
    }

    func testFormattedUsesTheCurrencySymbol() {
        XCTAssertEqual(Money(cents: 499).formatted(), "$4.99")
    }
}
