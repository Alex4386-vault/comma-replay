package geocode

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/Alex4386-vault/comma-replay/server/internal/persist"
)

type Place struct {
	Place  string `json:"place"`
	Region string `json:"region"`
}

// fallbackTTL keeps a coordinate label from a failed lookup only briefly, so the
// next request retries the provider instead of serving coordinates for good.
const fallbackTTL = 10 * time.Minute

type Cache struct {
	mu       sync.RWMutex
	byKey    map[string]entry
	ttl      time.Duration
	client   *http.Client
	inflight map[string]*call
	file     *persist.File
}

type entry struct {
	Place    Place     `json:"place"`
	At       time.Time `json:"at"`
	Fallback bool      `json:"-"`
}

type call struct {
	done  chan struct{}
	place Place
	err   error
}

// New loads the cache from path ("" keeps it in memory only).
func New(ttl time.Duration, path string) (*Cache, error) {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	c := &Cache{
		byKey:    make(map[string]entry),
		ttl:      ttl,
		client:   &http.Client{Timeout: 8 * time.Second},
		inflight: make(map[string]*call),
	}
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
		if !v.Fallback {
			out[k] = v
		}
	}
	return out
}

// Run persists changes until ctx ends.
func (c *Cache) Run(ctx context.Context) { c.file.Run(ctx) }

func (e entry) fresh(ttl time.Duration) bool {
	if e.Fallback {
		return time.Since(e.At) < fallbackTTL
	}
	return time.Since(e.At) < ttl
}

func key(lat, lon float64) string {
	return fmt.Sprintf("%.3f,%.3f", lat, lon)
}

func (c *Cache) Lookup(lat, lon float64) (Place, error) {
	k := key(lat, lon)

	c.mu.RLock()
	if e, ok := c.byKey[k]; ok && e.fresh(c.ttl) {
		c.mu.RUnlock()
		return e.Place, nil
	}
	c.mu.RUnlock()

	c.mu.Lock()
	if e, ok := c.byKey[k]; ok && e.fresh(c.ttl) {
		c.mu.Unlock()
		return e.Place, nil
	}
	if inflight, ok := c.inflight[k]; ok {
		c.mu.Unlock()
		<-inflight.done
		return inflight.place, inflight.err
	}
	inflight := &call{done: make(chan struct{})}
	c.inflight[k] = inflight
	c.mu.Unlock()

	place, err := c.fetch(lat, lon)
	fallback := err != nil
	if fallback {
		place = coordFallback(lat, lon)
		err = nil
	}

	c.mu.Lock()
	c.byKey[k] = entry{Place: place, At: time.Now(), Fallback: fallback}
	inflight.place = place
	inflight.err = err
	delete(c.inflight, k)
	close(inflight.done)
	c.mu.Unlock()
	if !fallback {
		c.file.MarkDirty()
	}

	return place, nil
}

func (c *Cache) fetch(lat, lon float64) (Place, error) {
	u := "https://api.bigdatacloud.net/data/reverse-geocode-client" +
		"?latitude=" + url.QueryEscape(fmt.Sprintf("%f", lat)) +
		"&longitude=" + url.QueryEscape(fmt.Sprintf("%f", lon)) +
		"&localityLanguage=en"
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return Place{}, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return Place{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Place{}, fmt.Errorf("geocode: %s", resp.Status)
	}
	var body struct {
		Locality             string `json:"locality"`
		City                 string `json:"city"`
		PrincipalSubdivision string `json:"principalSubdivision"`
		CountryName          string `json:"countryName"`
		LocalityInfo         struct {
			Administrative []struct {
				Name       string `json:"name"`
				AdminLevel int    `json:"adminLevel"`
			} `json:"administrative"`
		} `json:"localityInfo"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Place{}, err
	}
	neighbourhood := body.Locality
	if neighbourhood == "" {
		neighbourhood = body.City
	}
	for _, a := range body.LocalityInfo.Administrative {
		if a.AdminLevel >= 8 && a.Name != "" {
			neighbourhood = a.Name
			break
		}
	}
	if neighbourhood == "" {
		neighbourhood = "—"
	}
	regionParts := make([]string, 0, 2)
	if body.City != "" && body.City != neighbourhood {
		regionParts = append(regionParts, body.City)
	}
	if body.PrincipalSubdivision != "" {
		regionParts = append(regionParts, body.PrincipalSubdivision)
	}
	region := joinComma(regionParts)
	if region == "" {
		region = body.CountryName
	}
	if region == "" {
		region = "—"
	}
	return Place{Place: neighbourhood, Region: region}, nil
}

func coordFallback(lat, lon float64) Place {
	ns := "N"
	if lat < 0 {
		ns = "S"
	}
	ew := "E"
	if lon < 0 {
		ew = "W"
	}
	return Place{
		Place:  fmt.Sprintf("%.4f° %s", abs(lat), ns),
		Region: fmt.Sprintf("%.4f° %s", abs(lon), ew),
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func joinComma(parts []string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += ", "
		}
		out += p
	}
	return out
}
