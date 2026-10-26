package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/Alex4386-vault/comma-replay/server/internal/auth"
	"github.com/Alex4386-vault/comma-replay/server/internal/config"
	"github.com/Alex4386-vault/comma-replay/server/internal/geocode"
	"github.com/Alex4386-vault/comma-replay/server/internal/meta"
	"github.com/Alex4386-vault/comma-replay/server/internal/persist"
	"github.com/Alex4386-vault/comma-replay/server/internal/store"
)

type Server struct {
	cfg      config.Config
	store    *store.Store
	sessions *auth.Store
	geocode  *geocode.Cache
	meta     *meta.Cache

	routesMu    sync.Mutex
	routesCache map[string]*routesEntry
}

// After this long a device listing is rescanned in the background on the next
// request; the request itself still gets the cached listing straight away.
const routesStale = 15 * time.Second

type routesEntry struct {
	scanMu     sync.Mutex // one scan of a device at a time
	at         time.Time
	scan       store.Scan
	routes     []store.Route
	loaded     bool
	refreshing bool
}

// routesFile is where a device's scan is kept between restarts.
type routesFile struct {
	At   time.Time  `json:"at"`
	Scan store.Scan `json:"scan"`
}

func New(cfg config.Config, st *store.Store, sessions *auth.Store, geo *geocode.Cache, driveMeta *meta.Cache) *Server {
	return &Server{
		cfg:         cfg,
		store:       st,
		sessions:    sessions,
		geocode:     geo,
		meta:        driveMeta,
		routesCache: make(map[string]*routesEntry),
	}
}

func (s *Server) routesPath(userID, deviceID string) string {
	if s.cfg.CacheDir == "" {
		return ""
	}
	return filepath.Join(s.cfg.CacheDir, "routes", userID+"_"+deviceID+".json")
}

// routes returns a device's listing, stale-while-revalidate: a cached (or
// persisted) listing is returned immediately and rescanned in the background
// once stale. Only a cold start or ?fresh=1 waits for a scan.
func (s *Server) routes(userID, deviceID string, fresh bool) ([]store.Route, error) {
	key := userID + "/" + deviceID
	s.routesMu.Lock()
	e, ok := s.routesCache[key]
	if !ok {
		e = &routesEntry{}
		s.routesCache[key] = e
	}
	if !e.loaded {
		var f routesFile
		if err := persist.Load(s.routesPath(userID, deviceID), &f); err != nil {
			log.Printf("routes cache %s: %v", key, err)
		} else if f.Scan != nil {
			e.at, e.scan, e.routes, e.loaded = f.At, f.Scan, store.RoutesFromScan(f.Scan), true
		}
	}
	if e.loaded && !fresh {
		routes := e.routes
		if time.Since(e.at) > routesStale && !e.refreshing {
			e.refreshing = true
			go func() {
				if _, err := s.rescan(userID, deviceID, e, true); err != nil {
					log.Printf("routes rescan %s: %v", key, err)
				}
			}()
		}
		s.routesMu.Unlock()
		return routes, nil
	}
	s.routesMu.Unlock()
	return s.rescan(userID, deviceID, e, fresh)
}

// rescan scans the device, reusing unchanged dirs from the last scan. Without
// force, a caller that waited behind another scan takes that scan's result.
func (s *Server) rescan(userID, deviceID string, e *routesEntry, force bool) ([]store.Route, error) {
	e.scanMu.Lock()
	defer e.scanMu.Unlock()
	s.routesMu.Lock()
	if !force && e.loaded {
		routes := e.routes
		s.routesMu.Unlock()
		return routes, nil
	}
	prev := e.scan
	s.routesMu.Unlock()

	scan, err := s.store.ScanDevice(userID, deviceID, prev)
	s.routesMu.Lock()
	e.refreshing = false
	if err != nil {
		s.routesMu.Unlock()
		return nil, err
	}
	at := time.Now()
	routes := store.RoutesFromScan(scan)
	e.at, e.scan, e.routes, e.loaded = at, scan, routes, true
	s.routesMu.Unlock()

	if path := s.routesPath(userID, deviceID); path != "" {
		if err := persist.Save(path, routesFile{At: at, Scan: scan}); err != nil {
			log.Printf("routes cache %s/%s: %v", userID, deviceID, err)
		}
	}
	return routes, nil
}

// routeSignature is the route's current file signature, for meta cache checks.
func (s *Server) routeSignature(userID, deviceID, routeID string) (string, bool) {
	routes, err := s.routes(userID, deviceID, false)
	if err != nil {
		return "", false
	}
	for _, r := range routes {
		if r.ID == routeID {
			return r.Signature(), true
		}
	}
	return "", false
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Compress(5, "application/json"))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.cfg.FrontendOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
	}))

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/auth", func(r chi.Router) {
		r.Get("/config", s.handleAuthConfig)
		r.Post("/session", s.handleSession)
		r.Post("/logout", s.handleLogout)
	})

	r.Route("/api", func(r chi.Router) {
		r.Use(s.requireBearer)
		r.Get("/me", s.handleMe)
		r.Get("/geocode", s.handleGeocode)
		r.Get("/devices", s.handleDevices)
		r.Get("/devices/{deviceID}/records", s.handleRecords)
		r.Get("/devices/{deviceID}/routes", s.handleRoutes)
		r.Get("/devices/{deviceID}/records/{recordID}/files", s.handleRecordFiles)
		r.Get("/devices/{deviceID}/records/{recordID}/files/*", s.handleServeFile)
		r.Get("/devices/{deviceID}/records/{recordID}/meta", s.handleGetDriveMeta)
		r.Put("/devices/{deviceID}/records/{recordID}/meta", s.handlePutDriveMeta)
	})

	return r
}

func (s *Server) requireBearer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.sessions.GetFromRequest(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if len(s.cfg.AllowedUserIDs) > 0 {
			if _, ok := s.cfg.AllowedUserIDs[sess.User.ID]; !ok {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		ctx := context.WithValue(r.Context(), sessionKey{}, sess)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type sessionKey struct{}

func sessionFrom(ctx context.Context) (auth.Session, bool) {
	s, ok := ctx.Value(sessionKey{}).(auth.Session)
	return s, ok
}

type sessionRequest struct {
	Provider     string `json:"provider"`
	Code         string `json:"code"`
	CodeVerifier string `json:"codeVerifier"`
	RedirectURI  string `json:"redirectUri"`
}

type sessionResponse struct {
	Token string    `json:"token"`
	User  auth.User `json:"user"`
}

type authConfigResponse struct {
	GoogleClientID string `json:"googleClientId,omitempty"`
	GitHubClientID string `json:"githubClientId,omitempty"`
}

// handleAuthConfig returns public OAuth client IDs for the SPA authorize redirect (no secrets).
func (s *Server) handleAuthConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, authConfigResponse{
		GoogleClientID: s.cfg.GoogleClientID,
		GitHubClientID: s.cfg.GitHubClientID,
	})
}

// handleSession: FE PKCE code → server token exchange → opaque API bearer.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	var body sessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	body.Provider = strings.ToLower(strings.TrimSpace(body.Provider))
	if body.Provider != "google" && body.Provider != "github" {
		http.Error(w, "unsupported provider", http.StatusBadRequest)
		return
	}

	ex := auth.TokenExchange{
		GoogleClientID:     s.cfg.GoogleClientID,
		GoogleClientSecret: s.cfg.GoogleClientSecret,
		GitHubClientID:     s.cfg.GitHubClientID,
		GitHubClientSecret: s.cfg.GitHubClientSecret,
	}
	accessToken, err := ex.ExchangeCode(r.Context(), body.Provider, body.Code, body.CodeVerifier, body.RedirectURI)
	if err != nil {
		log.Printf("auth: token exchange failed (provider=%s): %v", body.Provider, err)
		http.Error(w, "token exchange failed", http.StatusUnauthorized)
		return
	}
	user, err := auth.FetchUser(r.Context(), body.Provider, accessToken)
	if err != nil {
		log.Printf("auth: token validation failed (provider=%s): %v", body.Provider, err)
		http.Error(w, "token validation failed", http.StatusUnauthorized)
		return
	}
	sess, err := s.sessions.Issue(user)
	if err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, sessionResponse{Token: sess.Token, User: sess.User})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.RevokeFromRequest(r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	writeJSON(w, sess.User)
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	devs, err := s.store.ListDevices(sess.User.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"devices": devs})
}

func (s *Server) handleRecords(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	recs, err := s.store.ListRecords(sess.User.ID, deviceID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"records": recs})
}

type routeResponse struct {
	store.Route
	// Meta is the cached drive meta when it still matches the route's files.
	Meta *meta.DriveMeta `json:"meta,omitempty"`
}

// handleRoutes lists a device's routes with per-segment file kinds and any
// cached drive meta, so the drive list needs no per-drive requests.
func (s *Server) handleRoutes(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	routes, err := s.routes(sess.User.ID, deviceID, r.URL.Query().Get("fresh") == "1")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]routeResponse, len(routes))
	for i, rt := range routes {
		out[i] = routeResponse{Route: rt}
		if m, ok := s.meta.Get(sess.User.ID, deviceID, rt.ID, rt.Signature()); ok {
			out[i].Meta = &m
		}
	}
	writeJSON(w, map[string]any{"routes": out})
}

func (s *Server) handleRecordFiles(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	recordID := chi.URLParam(r, "recordID")
	files, err := s.store.ListRecord(sess.User.ID, deviceID, recordID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"files": files})
}

func (s *Server) handleServeFile(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	recordID := chi.URLParam(r, "recordID")
	rel := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	f, st, err := s.store.Open(sess.User.ID, deviceID, recordID, rel)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f.(io.ReadSeeker))
}

func (s *Server) handleGeocode(w http.ResponseWriter, r *http.Request) {
	lat, err1 := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lon, err2 := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if err1 != nil || err2 != nil {
		http.Error(w, "lat and lon required", http.StatusBadRequest)
		return
	}
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		http.Error(w, "invalid coordinates", http.StatusBadRequest)
		return
	}
	place, err := s.geocode.Lookup(lat, lon)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, place)
}

func (s *Server) handleGetDriveMeta(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	recordID := chi.URLParam(r, "recordID")
	sig, ok := s.routeSignature(sess.User.ID, deviceID, recordID)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	m, ok := s.meta.Get(sess.User.ID, deviceID, recordID, sig)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, m)
}

func (s *Server) handlePutDriveMeta(w http.ResponseWriter, r *http.Request) {
	sess, _ := sessionFrom(r.Context())
	deviceID := chi.URLParam(r, "deviceID")
	recordID := chi.URLParam(r, "recordID")
	var body meta.DriveMeta
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	switch body.Status {
	case "ready", "empty", "error":
	default:
		http.Error(w, "status must be ready, empty, or error", http.StatusBadRequest)
		return
	}
	sig, ok := s.routeSignature(sess.User.ID, deviceID, recordID)
	if !ok {
		http.Error(w, "unknown route", http.StatusNotFound)
		return
	}
	s.meta.Put(sess.User.ID, deviceID, recordID, sig, body)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
