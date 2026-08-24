package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// FetchUser validates a provider access token via userinfo and returns a User.
func FetchUser(ctx context.Context, provider, accessToken string) (User, error) {
	if accessToken == "" {
		return User{}, fmt.Errorf("missing access token")
	}
	switch provider {
	case "google":
		return fetchGoogleUser(ctx, accessToken)
	case "github":
		return fetchGitHubUser(ctx, accessToken)
	default:
		return User{}, fmt.Errorf("unknown provider %q", provider)
	}
}

func fetchGoogleUser(ctx context.Context, accessToken string) (User, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return User{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("google userinfo: %s", resp.Status)
	}
	var body struct {
		ID      string `json:"id"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return User{}, err
	}
	if body.ID == "" {
		return User{}, fmt.Errorf("google userinfo: empty id")
	}
	return User{
		ID:        body.ID,
		Email:     body.Email,
		Name:      body.Name,
		Provider:  "google",
		AvatarURL: body.Picture,
	}, nil
}

func fetchGitHubUser(ctx context.Context, accessToken string) (User, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return User{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("github user: %s", resp.Status)
	}
	var body struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return User{}, err
	}
	email := body.Email
	if email == "" {
		email = fetchGitHubPrimaryEmail(ctx, accessToken)
	}
	name := body.Name
	if name == "" {
		name = body.Login
	}
	return User{
		ID:        fmt.Sprintf("%d", body.ID),
		Email:     email,
		Name:      name,
		Provider:  "github",
		AvatarURL: body.AvatarURL,
	}, nil
}

func fetchGitHubPrimaryEmail(ctx context.Context, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user/emails", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if json.Unmarshal(b, &emails) != nil {
		return ""
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email
		}
	}
	if len(emails) > 0 {
		return emails[0].Email
	}
	return ""
}
