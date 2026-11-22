/// The currencies the shop sells in.
public enum Currency: String, CaseIterable {
    case usd, eur, gbp

    public func symbol() -> String {
        switch self {
        case .usd: return "$"
        case .eur: return "€"
        case .gbp: return "£"
        }
    }
}
