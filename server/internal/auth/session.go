package auth

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

type User struct {
	ID        string `json:"id"`
	Email     string `json:"email,omitempty"`
	Name      string `json:"name,omitempty"`
	Provider  string `json:"provider"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

type Session struct {
	Token     string
	User      User
	ExpiresAt time.Time
}

type Store struct {
	ttl   time.Duration
	mu    sync.RWMutex
	byTok map[string]Session
}

func NewStore(ttl time.Duration) *Store {
	return &Store{
		ttl:   ttl,
		byTok: make(map[string]Session),
	}
}

// Issue creates an opaque API token (no cookies).
func (s *Store) Issue(user User) (Session, error) {
	tok, err := randomToken(32)
	if err != nil {
		return Session{}, err
	}
	sess := Session{
		Token:     tok,
		User:      user,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	s.mu.Lock()
	s.byTok[tok] = sess
	s.mu.Unlock()
	return sess, nil
}

func (s *Store) Get(token string) (Session, bool) {
	if token == "" {
		return Session{}, false
	}
	s.mu.RLock()
	sess, ok := s.byTok[token]
	s.mu.RUnlock()
	if !ok || time.Now().After(sess.ExpiresAt) {
		return Session{}, false
	}
	return sess, true
}

func (s *Store) GetFromRequest(r *http.Request) (Session, bool) {
	return s.Get(bearerToken(r))
}

func (s *Store) Revoke(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	delete(s.byTok, token)
	s.mu.Unlock()
}

func (s *Store) RevokeFromRequest(r *http.Request) {
	s.Revoke(bearerToken(r))
}

func (s *Store) UserJSON(sess Session) []byte {
	b, _ := json.Marshal(sess.User)
	return b
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
