package store_test

import (
	"errors"
	"testing"

	"example.com/shop/internal/store"
)

func TestAddThenGet(t *testing.T) {
	s := store.New()
	added := s.Add("Teapot", 2400)

	got, err := s.Get(added.ID)
	if err != nil {
		t.Fatalf("Get(%q): %v", added.ID, err)
	}
	if got != added {
		t.Errorf("Get(%q) = %+v, want %+v", added.ID, got, added)
	}
}

func TestGetMissing(t *testing.T) {
	if _, err := store.New().Get("nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Get of a missing item: err = %v, want ErrNotFound", err)
	}
}
