package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Alex4386-vault/comma-replay/server/internal/config"
	"github.com/Alex4386-vault/comma-replay/server/internal/store"
)

func TestRoutesServedFromPersistedScan(t *testing.T) {
	root, cacheDir := t.TempDir(), t.TempDir()
	seg := filepath.Join(root, "github_1", "dev", "0000027e--11b9b83499--0")
	if err := os.MkdirAll(seg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(seg, "qlog.zst"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := store.New(root)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{CacheDir: cacheDir}

	first, err := New(cfg, st, nil, nil, nil).routes("github_1", "dev", false)
	if err != nil || len(first) != 1 {
		t.Fatalf("cold scan = %v, %v", first, err)
	}

	// A new segment synced since; a restarted server answers from the persisted
	// scan right away and picks the segment up in the background.
	if err := os.MkdirAll(filepath.Join(root, "github_1", "dev", "0000027f--aaaaaaaaaa--0"), 0o755); err != nil {
		t.Fatal(err)
	}
	restarted := New(cfg, st, nil, nil, nil)
	stale, err := restarted.routes("github_1", "dev", false)
	if err != nil || len(stale) != 1 {
		t.Fatalf("persisted listing = %v, %v", stale, err)
	}
	restarted.routesCache["github_1/dev"].at = time.Now().Add(-time.Hour)
	restarted.routes("github_1", "dev", false) // kicks off the background rescan
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _ := restarted.routes("github_1", "dev", false)
		if len(got) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background rescan never landed: %v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}

	fresh, err := restarted.routes("github_1", "dev", true)
	if err != nil || len(fresh) != 2 {
		t.Fatalf("fresh scan = %v, %v", fresh, err)
	}
}
