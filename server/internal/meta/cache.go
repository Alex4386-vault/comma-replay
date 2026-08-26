package meta

import (
	"sync"
	"time"
)

// DriveMeta mirrors the SPA driveMeta shape (terminal statuses for cache).
type DriveMeta struct {
	Status string   `json:"status"` // ready | empty | error
	First  *GpsFix  `json:"first"`
	Last   *GpsFix  `json:"last"`
	Start  *Place   `json:"start,omitempty"`
	End    *Place   `json:"end,omitempty"`
	Error  string   `json:"error,omitempty"`
}

type GpsFix struct {
	Latitude             float64 `json:"latitude"`
	Longitude            float64 `json:"longitude"`
	UnixTimestampMillis  *int64  `json:"unixTimestampMillis"`
}

type Place struct {
	Place  string `json:"place"`
	Region string `json:"region"`
}

type Cache struct {
	mu    sync.RWMutex
	byKey map[string]entry
	ttl   time.Duration
}

type entry struct {
	meta DriveMeta
	at   time.Time
}

func New(ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	return &Cache{
		byKey: make(map[string]entry),
		ttl:   ttl,
	}
}

func cacheKey(userID, deviceID, recordID string) string {
	return userID + "\x00" + deviceID + "\x00" + recordID
}

func (c *Cache) Get(userID, deviceID, recordID string) (DriveMeta, bool) {
	k := cacheKey(userID, deviceID, recordID)
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.byKey[k]
	if !ok || time.Since(e.at) >= c.ttl {
		return DriveMeta{}, false
	}
	return e.meta, true
}

func (c *Cache) Put(userID, deviceID, recordID string, meta DriveMeta) {
	switch meta.Status {
	case "ready", "empty", "error":
	default:
		return
	}
	k := cacheKey(userID, deviceID, recordID)
	c.mu.Lock()
	c.byKey[k] = entry{meta: meta, at: time.Now()}
	c.mu.Unlock()
}
