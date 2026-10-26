package meta

import (
	"context"
	"path/filepath"
	"testing"
)

func TestCachePersistsAndChecksSignature(t *testing.T) {
	path := filepath.Join(t.TempDir(), "drive-meta.json")
	c, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	c.Put("u", "d", "r", "2:0,", DriveMeta{Status: "empty"})
	if _, ok := c.Get("u", "d", "r", "2:0,1,"); ok {
		t.Fatal("meta computed before a qlog synced must not match the new signature")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.Run(ctx) // flushes once on exit

	reloaded, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	m, ok := reloaded.Get("u", "d", "r", "2:0,")
	if !ok || m.Status != "empty" {
		t.Fatalf("reloaded = %+v, %v", m, ok)
	}
}
