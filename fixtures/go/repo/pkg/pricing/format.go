package pricing

import "fmt"

// Currency is the ISO 4217 code every price is quoted in.
const Currency = "EUR"

// Format renders an amount in cents for display, for example "24.00 EUR".
func Format(cents int64) string {
	return fmt.Sprintf("%d.%02d %s", cents/100, cents%100, Currency)
}
