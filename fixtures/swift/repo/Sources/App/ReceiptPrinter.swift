import Core

public protocol Printer {
    func emit(_ line: String)
}

public struct ConsolePrinter: Printer {
    public init() {}

    public func emit(_ line: String) {
        print(line)
    }
}

public final class ReceiptPrinter {
    private let printer: Printer

    public init(printer: Printer = ConsolePrinter()) {
        self.printer = printer
    }

    public func printReceipt(_ receipt: Receipt) {
        printer.emit(receipt.summary())
        printer.emit("Shop core \(Core.version)")
    }
}
