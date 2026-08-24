package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr               string
	DataRoot           string
	FrontendOrigins    []string
	GoogleClientID     string
	GoogleClientSecret string // optional; server-only
	GitHubClientID     string
	GitHubClientSecret string // required for GitHub code exchange; server-only
	SessionTTL         time.Duration
	AllowedUserIDs     map[string]struct{}
}

func FromEnv() (Config, error) {
	cfg := Config{
		Addr:               getenv("REPLAY_ADDR", ":8080"),
		DataRoot:           getenv("REPLAY_DATA_ROOT", "./data"),
		FrontendOrigins:    splitOrigins(getenv("REPLAY_FRONTEND_ORIGIN", "http://localhost:5173")),
		GoogleClientID:     strings.TrimSpace(os.Getenv("REPLAY_GOOGLE_CLIENT_ID")),
		GoogleClientSecret: strings.TrimSpace(os.Getenv("REPLAY_GOOGLE_CLIENT_SECRET")),
		GitHubClientID:     strings.TrimSpace(os.Getenv("REPLAY_GITHUB_CLIENT_ID")),
		GitHubClientSecret: strings.TrimSpace(os.Getenv("REPLAY_GITHUB_CLIENT_SECRET")),
		SessionTTL:         7 * 24 * time.Hour,
	}
	if raw := os.Getenv("REPLAY_ALLOWED_USER_IDS"); raw != "" {
		cfg.AllowedUserIDs = make(map[string]struct{})
		for _, id := range strings.Split(raw, ",") {
			id = strings.TrimSpace(id)
			if id != "" {
				cfg.AllowedUserIDs[id] = struct{}{}
			}
		}
	}
	return cfg, nil
}

func splitOrigins(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		o := strings.TrimRight(strings.TrimSpace(p), "/")
		if o == "" {
			continue
		}
		if _, ok := seen[o]; ok {
			continue
		}
		seen[o] = struct{}{}
		out = append(out, o)
	}
	if len(out) == 0 {
		return []string{"http://localhost:5173"}
	}
	return out
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
