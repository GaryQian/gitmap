package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"example.com/shop/internal/store"
	price "example.com/shop/pkg/pricing"
)

// itemView is an item as the API returns it: the stored fields plus the total to pay.
type itemView struct {
	store.Item
	Total string `json:"total"`
}

func (s *Server) view(it store.Item) itemView {
	total := price.WithTax(it.Cents, s.taxRate)
	return itemView{Item: it, Total: price.Format(total)}
}

func (s *Server) listItems(w http.ResponseWriter, r *http.Request) {
	items := s.items.List()
	views := make([]itemView, 0, len(items))
	for _, it := range items {
		views = append(views, s.view(it))
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) getItem(w http.ResponseWriter, r *http.Request) {
	it, err := s.items.Get(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, s.view(it))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("server: writing response: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
