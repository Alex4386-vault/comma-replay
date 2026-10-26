package persist

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// File mirrors an in-memory cache to a JSON file: Load once at startup, call
// MarkDirty after each write, and Run saves at most once per interval so a
// restart keeps the cache. An empty path disables persistence.
type File struct {
	path     string
	interval time.Duration
	snapshot func() any
	dirty    atomic.Bool
}

func New(path string, interval time.Duration, snapshot func() any) *File {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return &File{path: path, interval: interval, snapshot: snapshot}
}

// Load decodes path into v. A missing file (or an empty path) is not an error.
func Load(path string, v any) error {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (f *File) MarkDirty() {
	if f != nil && f.path != "" {
		f.dirty.Store(true)
	}
}

// Run saves dirty snapshots every interval until ctx ends, then once more.
func (f *File) Run(ctx context.Context) {
	if f == nil || f.path == "" {
		return
	}
	t := time.NewTicker(f.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			if err := f.Flush(); err != nil {
				log.Printf("persist %s: %v", f.path, err)
			}
			return
		case <-t.C:
			if err := f.Flush(); err != nil {
				log.Printf("persist %s: %v", f.path, err)
			}
		}
	}
}

// Flush writes the snapshot if anything changed since the last save.
func (f *File) Flush() error {
	if f == nil || f.path == "" || !f.dirty.Swap(false) {
		return nil
	}
	if err := save(f.path, f.snapshot()); err != nil {
		f.dirty.Store(true)
		return err
	}
	return nil
}

// save writes v next to path and renames it into place, so a crash mid-write
// never leaves a truncated cache behind.
func save(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
