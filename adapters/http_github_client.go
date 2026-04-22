package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// githubAPIBaseURL is the REST API base. Only github.com is supported —
// custom GitHub Enterprise base URLs are not currently wired through,
// and accepting arbitrary ones would be an SSRF vector for a future
// hosted deployment.
const githubAPIBaseURL = "https://api.github.com"

// HttpGitHubClient is the production GitHubClient, backed by net/http
// against api.github.com.
type HttpGitHubClient struct {
	// client is exposed for test injection (e.g. httptest.Server-based
	// integration tests in adapters/). Domain tests should use
	// fakes.FakeGitHubClient instead.
	client *http.Client
	base   string
}

// NewHttpGitHubClient constructs the production HTTP-backed client using
// http.DefaultClient against api.github.com.
func NewHttpGitHubClient() *HttpGitHubClient {
	return &HttpGitHubClient{client: http.DefaultClient, base: githubAPIBaseURL}
}

// ValidateToken calls GET /user with the provided bearer token. The
// returned scopes come from the X-OAuth-Scopes response header, which is
// GitHub's canonical place to advertise classic PAT / OAuth scopes.
func (c *HttpGitHubClient) ValidateToken(ctx context.Context, token string) (*ports.GitHubUser, []string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/user", nil)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to call GitHub API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, nil, fmt.Errorf("invalid or expired token")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var scopes []string
	if header := resp.Header.Get("X-OAuth-Scopes"); header != "" {
		for _, s := range strings.Split(header, ",") {
			if scope := strings.TrimSpace(s); scope != "" {
				scopes = append(scopes, scope)
			}
		}
	}

	var body struct {
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
		Email     string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, nil, fmt.Errorf("failed to parse GitHub response: %w", err)
	}

	return &ports.GitHubUser{
		Login:     body.Login,
		Name:      body.Name,
		AvatarURL: body.AvatarURL,
		Email:     body.Email,
	}, scopes, nil
}
