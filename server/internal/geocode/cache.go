package geocode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Place struct {
	Place  string `json:"place"`
	Region string `json:"region"`
}

type Cache struct {
	mu      sync.RWMutex
	byKey   map[string]entry
	ttl     time.Duration
	client  *http.Client
	inflight map[string]*call
}

type entry struct {
	place Place
	at    time.Time
}

type call struct {
	done chan struct{}
	place Place
	err   error
}

func New(ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	return &Cache{
		byKey:    make(map[string]entry),
		ttl:      ttl,
		client:   &http.Client{Timeout: 8 * time.Second},
		inflight: make(map[string]*call),
	}
}

func key(lat, lon float64) string {
	return fmt.Sprintf("%.3f,%.3f", lat, lon)
}

func (c *Cache) Lookup(lat, lon float64) (Place, error) {
	k := key(lat, lon)

	c.mu.RLock()
	if e, ok := c.byKey[k]; ok && time.Since(e.at) < c.ttl {
		c.mu.RUnlock()
		return e.place, nil
	}
	c.mu.RUnlock()

	c.mu.Lock()
	if e, ok := c.byKey[k]; ok && time.Since(e.at) < c.ttl {
		c.mu.Unlock()
		return e.place, nil
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
	if err != nil {
		place = coordFallback(lat, lon)
		err = nil
	}

	c.mu.Lock()
	c.byKey[k] = entry{place: place, at: time.Now()}
	inflight.place = place
	inflight.err = err
	delete(c.inflight, k)
	close(inflight.done)
	c.mu.Unlock()

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
