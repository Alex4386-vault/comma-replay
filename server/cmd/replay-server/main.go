package main

import (
	"log"
	"net/http"
	"time"

	"github.com/Alex4386-vault/comma-replay/server/internal/auth"
	"github.com/Alex4386-vault/comma-replay/server/internal/config"
	"github.com/Alex4386-vault/comma-replay/server/internal/geocode"
	"github.com/Alex4386-vault/comma-replay/server/internal/meta"
	"github.com/Alex4386-vault/comma-replay/server/internal/server"
	"github.com/Alex4386-vault/comma-replay/server/internal/store"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatal(err)
	}

	st, err := store.New(cfg.DataRoot)
	if err != nil {
		log.Fatal(err)
	}

	sessions := auth.NewStore(cfg.SessionTTL)
	geo := geocode.New(24 * time.Hour)
	driveMeta := meta.New(7 * 24 * time.Hour)
	srv := server.New(cfg, st, sessions, geo, driveMeta)

	log.Printf("replay-server listening on %s (data root: %s)", cfg.Addr, cfg.DataRoot)
	log.Fatal(http.ListenAndServe(cfg.Addr, srv.Handler()))
}
