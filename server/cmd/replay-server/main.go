package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Alex4386-vault/comma-replay/server/internal/auth"
	"github.com/Alex4386-vault/comma-replay/server/internal/config"
	"github.com/Alex4386-vault/comma-replay/server/internal/geocode"
	"github.com/Alex4386-vault/comma-replay/server/internal/meta"
	"github.com/Alex4386-vault/comma-replay/server/internal/server"
	"github.com/Alex4386-vault/comma-replay/server/internal/store"
)

func cachePath(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatal(err)
	}

	st, err := store.New(cfg.DataRoot)
	if err != nil {
		log.Fatal(err)
	}

	geo, err := geocode.New(180*24*time.Hour, cachePath(cfg.CacheDir, "geocode.json"))
	if err != nil {
		log.Fatalf("geocode cache: %v", err)
	}
	driveMeta, err := meta.New(cachePath(cfg.CacheDir, "drive-meta.json"))
	if err != nil {
		log.Fatalf("drive meta cache: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	persisted := make(chan struct{}, 2)
	for _, run := range []func(context.Context){geo.Run, driveMeta.Run} {
		go func(run func(context.Context)) {
			run(ctx)
			persisted <- struct{}{}
		}(run)
	}

	sessions := auth.NewStore(cfg.SessionTTL)
	srv := server.New(cfg, st, sessions, geo, driveMeta)
	httpSrv := &http.Server{Addr: cfg.Addr, Handler: srv.Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("replay-server listening on %s (data root: %s, cache dir: %s)", cfg.Addr, cfg.DataRoot, cfg.CacheDir)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	// Caches flush on shutdown; wait so a restart keeps the latest entries.
	<-persisted
	<-persisted
}
