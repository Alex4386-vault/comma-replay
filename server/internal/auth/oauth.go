package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// TokenExchange holds provider app credentials used only on the server.
type TokenExchange struct {
	GoogleClientID     string
	GoogleClientSecret string // optional for public PKCE clients
	GitHubClientID     string
	GitHubClientSecret string // required for GitHub OAuth Apps
}

// ExchangeCode swaps an auth code (+ PKCE verifier) for a provider access token.
// Must run on the server — GitHub's token endpoint does not allow browser CORS.
func (t TokenExchange) ExchangeCode(ctx context.Context, provider, code, codeVerifier, redirectURI string) (string, error) {
	if code == "" || codeVerifier == "" || redirectURI == "" {
		return "", fmt.Errorf("missing code, code_verifier, or redirect_uri")
	}
	switch provider {
	case "google":
		return t.exchangeGoogle(ctx, code, codeVerifier, redirectURI)
	case "github":
		return t.exchangeGitHub(ctx, code, codeVerifier, redirectURI)
	default:
		return "", fmt.Errorf("unknown provider %q", provider)
	}
}

func (t TokenExchange) exchangeGoogle(ctx context.Context, code, codeVerifier, redirectURI string) (string, error) {
	if t.GoogleClientID == "" {
		return "", fmt.Errorf("google client id not configured")
	}
	form := url.Values{
		"client_id":     {t.GoogleClientID},
		"code":          {code},
		"code_verifier": {codeVerifier},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	}
	if t.GoogleClientSecret != "" {
		form.Set("client_secret", t.GoogleClientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("google token: %s %s", resp.Status, truncate(body, 200))
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("google token: missing access_token")
	}
	return out.AccessToken, nil
}

func (t TokenExchange) exchangeGitHub(ctx context.Context, code, codeVerifier, redirectURI string) (string, error) {
	if t.GitHubClientID == "" || t.GitHubClientSecret == "" {
		return "", fmt.Errorf("github client id/secret not configured")
	}
	form := url.Values{
		"client_id":     {t.GitHubClientID},
		"client_secret": {t.GitHubClientSecret},
		"code":          {code},
		"code_verifier": {codeVerifier},
		"redirect_uri":  {redirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github token: %s %s", resp.Status, truncate(body, 200))
	}
	var out struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Error != "" || out.AccessToken == "" {
		if out.ErrorDescription != "" {
			return "", fmt.Errorf("github token: %s", out.ErrorDescription)
		}
		if out.Error != "" {
			return "", fmt.Errorf("github token: %s", out.Error)
		}
		return "", fmt.Errorf("github token: missing access_token")
	}
	return out.AccessToken, nil
}

func truncate(b []byte, n int) string {
	s := string(b)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

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
