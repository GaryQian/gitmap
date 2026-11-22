import Foundation
import struct Core.Money

/// What the customer gets once a checkout completes.
public struct Receipt {
    public let id: UUID
    public let total: Money
    public let issuedAt: Date

    public func summary() -> String {
        "Receipt \(id.uuidString): \(total.formatted())"
    }
}
