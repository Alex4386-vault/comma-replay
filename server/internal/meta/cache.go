package meta

import (
	"context"
	"sync"
	"time"

	"github.com/Alex4386-vault/comma-replay/server/internal/persist"
)

// DriveMeta mirrors the SPA driveMeta shape (terminal statuses for cache).
type DriveMeta struct {
	Status string  `json:"status"` // ready | empty | error
	First  *GpsFix `json:"first"`
	Last   *GpsFix `json:"last"`
	Start  *Place  `json:"start,omitempty"`
	End    *Place  `json:"end,omitempty"`
	Error  string  `json:"error,omitempty"`
}

type GpsFix struct {
	Latitude            float64 `json:"latitude"`
	Longitude           float64 `json:"longitude"`
	UnixTimestampMillis *int64  `json:"unixTimestampMillis"`
}

type Place struct {
	Place  string `json:"place"`
	Region string `json:"region"`
}

// Cache holds drive meta per route, persisted to disk. Each entry remembers the
// route's file signature when it was computed (which segments had a qlog), so a
// drive cached as "empty" while its logs were still syncing is recomputed once
// they arrive instead of staying empty forever.
type Cache struct {
	mu    sync.RWMutex
	byKey map[string]entry
	file  *persist.File
}

type entry struct {
	Meta DriveMeta `json:"meta"`
	Sig  string    `json:"sig"`
	At   time.Time `json:"at"`
}

// New loads the cache from path ("" keeps it in memory only).
func New(path string) (*Cache, error) {
	c := &Cache{byKey: make(map[string]entry)}
	if err := persist.Load(path, &c.byKey); err != nil {
		return nil, err
	}
	c.file = persist.New(path, 5*time.Second, c.snapshot)
	return c, nil
}

func (c *Cache) snapshot() any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]entry, len(c.byKey))
	for k, v := range c.byKey {
		out[k] = v
	}
	return out
}

// Run persists changes until ctx ends.
func (c *Cache) Run(ctx context.Context) { c.file.Run(ctx) }

func cacheKey(userID, deviceID, routeID string) string {
	return userID + "/" + deviceID + "/" + routeID
}

// Get returns the cached meta if it was computed for the same file signature.
func (c *Cache) Get(userID, deviceID, routeID, sig string) (DriveMeta, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.byKey[cacheKey(userID, deviceID, routeID)]
	if !ok || e.Sig != sig {
		return DriveMeta{}, false
	}
	return e.Meta, true
}

func (c *Cache) Put(userID, deviceID, routeID, sig string, m DriveMeta) {
	switch m.Status {
	case "ready", "empty", "error":
	default:
		return
	}
	c.mu.Lock()
	c.byKey[cacheKey(userID, deviceID, routeID)] = entry{Meta: m, Sig: sig, At: time.Now()}
	c.mu.Unlock()
	c.file.MarkDirty()
}
