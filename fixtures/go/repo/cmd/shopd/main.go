// Command shopd serves the shop catalogue over HTTP.
package main

import (
	"flag"
	"log"
	"net/http"
	_ "net/http/pprof"

	"example.com/shop/internal/config"
	httpapi "example.com/shop/internal/server"
	"example.com/shop/internal/store"
)

func main() {
	path := flag.String("config", "shop.yaml", "path to the configuration file")
	flag.Parse()

	cfg, err := config.Load(*path)
	if err != nil {
		log.Fatalf("shopd: %v", err)
	}

	db := store.New()
	seed(db)

	srv := httpapi.New(db, cfg.TaxRate)
	log.Printf("shopd: listening on %s", cfg.Addr)
	log.Fatal(http.ListenAndServe(cfg.Addr, srv.Handler()))
}

// seed puts a few items on sale so a fresh server has something to show.
func seed(db *store.Store) {
	db.Add("Teapot", 2400)
	db.Add("Mug", 900)
}
