package store

import "errors"

// ErrNotFound is returned when no item has the requested ID.
var ErrNotFound = errors.New("store: item not found")

// Item is one product on sale.
type Item struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Cents int64  `json:"cents"`
}
