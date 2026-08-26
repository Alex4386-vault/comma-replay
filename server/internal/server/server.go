package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/Alex4386-vault/comma-replay/server/internal/auth"
	"github.com/Alex4386-vault/comma-replay/server/internal/config"
	"github.com/Alex4386-vault/comma-replay/server/internal/geocode"
	"github.com/Alex4386-vault/comma-replay/server/internal/meta"
	"github.com/Alex4386-vault/comma-replay/server/internal/store"
)

type Server struct {
	cfg      config.Config
	store    *store.Store
	sessions *auth.Store
	geocode  *geocode.Cache
	meta     *meta.Cache
}

func New(cfg config.Config, st *store.Store, sessions *auth.Store, geo *geocode.Cache, driveMeta *meta.Cache) *Server {
	return &Server{
		cfg:      cfg,
		store:    st,
		sessions: sessions,
		geocode:  geo,
		meta:     driveMeta,
	}
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
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
		http.Error(w, "token exchange failed", http.StatusUnauthorized)
		return
	}
	user, err := auth.FetchUser(r.Context(), body.Provider, accessToken)
	if err != nil {
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
	m, ok := s.meta.Get(sess.User.ID, deviceID, recordID)
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
	s.meta.Put(sess.User.ID, deviceID, recordID, body)
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
