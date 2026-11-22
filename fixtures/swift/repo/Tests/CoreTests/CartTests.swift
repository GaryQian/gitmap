import XCTest
@testable import Core

final class CartTests: XCTestCase {
    func testTotalAppliesRules() {
        let cart = Cart()
        cart.add(sampleItem(dollars: 4, quantity: 2))
        cart.add(sampleItem(dollars: 2))
        cart.addRule(PercentOff(percent: 10))
        XCTAssertEqual(cart.total(), Money(cents: 900))
    }

    func testEmptyCartIsFree() {
        XCTAssertEqual(Cart().total(), Money.zero(Core.defaultCurrency))
    }
}
