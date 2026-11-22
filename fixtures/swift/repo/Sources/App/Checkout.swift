import Foundation
import Core

/* The old flow, kept for reference until the payment migration is done:
   /* import LegacyPayments */
   import PaymentKit
*/

/// Turns a cart into a receipt.
public final class Checkout {
    private let cart: Cart
    private let printer: ReceiptPrinter

    public init(cart: Cart, printer: ReceiptPrinter = ReceiptPrinter()) {
        self.cart = cart
        self.printer = printer
    }

    public func applyDiscount(percent: Double) {
        cart.addRule(PercentOff(percent: percent))
    }

    public func complete() -> Receipt {
        let receipt = Receipt(id: UUID(), total: cart.total(), issuedAt: Date())
        printer.printReceipt(receipt)
        return receipt
    }
}
