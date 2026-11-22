// Package server exposes the catalogue over HTTP.
package server

import (
	"net/http"

	"example.com/shop/internal/store"
)

// Catalogue is what the server needs from the store.
type Catalogue interface {
	Get(id string) (store.Item, error)
	List() []store.Item
}

// Server routes requests to the catalogue.
type Server struct {
	items   Catalogue
	taxRate float64
}

// New returns a server over the given catalogue that adds tax at taxRate.
func New(items Catalogue, taxRate float64) *Server {
	return &Server{items: items, taxRate: taxRate}
}

// Handler returns the HTTP routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items", s.listItems)
	mux.HandleFunc("GET /items/{id}", s.getItem)
	return logRequests(mux)
}
