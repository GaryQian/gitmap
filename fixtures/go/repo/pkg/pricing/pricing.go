// Package pricing turns catalogue prices into what a customer pays.
package pricing

import "math"

// WithTax returns cents with tax added at the given rate, rounded to the nearest cent.
func WithTax(cents int64, rate float64) int64 {
	return cents + int64(math.Round(float64(cents)*rate))
}
