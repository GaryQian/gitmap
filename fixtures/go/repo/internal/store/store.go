// Package store keeps the catalogue in memory.
package store

import (
	"sort"
	"sync"
)

// Store is a catalogue of items, safe for concurrent use.
type Store struct {
	mu    sync.RWMutex
	items map[string]Item
}

// New returns an empty store.
func New() *Store {
	return &Store{items: make(map[string]Item)}
}

// Add puts a new item on sale and returns it.
func (s *Store) Add(name string, cents int64) Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	it := Item{ID: newID(), Name: name, Cents: cents}
	s.items[it.ID] = it
	return it
}

// Get returns the item with the given ID, or ErrNotFound.
func (s *Store) Get(id string) (Item, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	it, ok := s.items[id]
	if !ok {
		return Item{}, ErrNotFound
	}
	return it, nil
}

// List returns every item, ordered by name.
func (s *Store) List() []Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Item, 0, len(s.items))
	for _, it := range s.items {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
