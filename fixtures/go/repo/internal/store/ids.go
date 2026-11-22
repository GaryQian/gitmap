package store

import "github.com/google/uuid"

// newID returns a fresh item identifier.
func newID() string {
	return uuid.NewString()
}
