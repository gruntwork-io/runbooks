package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// roundTripFunc lets a test supply a plain function as an http.RoundTripper.
// This avoids the need for a real TCP listener (httptest.Server) so the tests
// work in network-restricted sandbox environments.
type roundTripFunc func(r *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// githubResponse is a convenience builder for well-formed GitHub /user JSON bodies.
type githubResponse struct {
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
}

func jsonBody(v any) io.ReadCloser {
	b, _ := json.Marshal(v)
	return io.NopCloser(bytes.NewReader(b))
}

// newMockedClient builds an HttpGitHubClient whose HTTP calls are intercepted
// by fn — no TCP socket is opened.
func newMockedClient(fn roundTripFunc) *HttpGitHubClient {
	return &HttpGitHubClient{
		client: &http.Client{Transport: fn},
		base:   "https://api.github.com", // real base; fn intercepts before dial
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — success path
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_Success(t *testing.T) {
	var capturedReq *http.Request

	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		capturedReq = r
		resp := &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: jsonBody(githubResponse{
				Login:     "octocat",
				Name:      "Octo Cat",
				AvatarURL: "https://github.com/images/octocat.png",
				Email:     "octocat@github.com",
			}),
		}
		resp.Header.Set("X-OAuth-Scopes", "repo, read:user")
		return resp, nil
	})

	user, scopes, err := c.ValidateToken(context.Background(), "test-token")

	if err != nil {
		t.Fatalf("ValidateToken: unexpected error: %v", err)
	}
	if user == nil {
		t.Fatal("ValidateToken: user is nil")
	}
	if user.Login != "octocat" {
		t.Errorf("user.Login = %q, want %q", user.Login, "octocat")
	}
	if user.Name != "Octo Cat" {
		t.Errorf("user.Name = %q, want %q", user.Name, "Octo Cat")
	}
	if user.AvatarURL != "https://github.com/images/octocat.png" {
		t.Errorf("user.AvatarURL = %q, want %q", user.AvatarURL, "https://github.com/images/octocat.png")
	}
	if user.Email != "octocat@github.com" {
		t.Errorf("user.Email = %q, want %q", user.Email, "octocat@github.com")
	}

	wantScopes := []string{"repo", "read:user"}
	if len(scopes) != len(wantScopes) {
		t.Fatalf("scopes = %v, want %v", scopes, wantScopes)
	}
	for i, s := range scopes {
		if s != wantScopes[i] {
			t.Errorf("scopes[%d] = %q, want %q", i, s, wantScopes[i])
		}
	}

	// Verify the request was wired up correctly.
	if capturedReq == nil {
		t.Fatal("no request was captured")
	}
	if capturedReq.URL.Path != "/user" {
		t.Errorf("path = %q, want /user", capturedReq.URL.Path)
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — request headers
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_SetsRequiredHeaders(t *testing.T) {
	var capturedHeaders http.Header

	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		capturedHeaders = r.Header.Clone()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       jsonBody(githubResponse{Login: "test"}),
		}, nil
	})

	_, _, _ = c.ValidateToken(context.Background(), "my-token")

	if got := capturedHeaders.Get("Authorization"); got != "Bearer my-token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer my-token")
	}
	if got := capturedHeaders.Get("Accept"); got != "application/vnd.github+json" {
		t.Errorf("Accept = %q, want %q", got, "application/vnd.github+json")
	}
	if got := capturedHeaders.Get("X-GitHub-Api-Version"); got != "2022-11-28" {
		t.Errorf("X-GitHub-Api-Version = %q, want %q", got, "2022-11-28")
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — 401 Unauthorized
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_Unauthorized(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	})

	user, scopes, err := c.ValidateToken(context.Background(), "bad-token")

	if err == nil {
		t.Fatal("ValidateToken: want error for 401, got nil")
	}
	if !strings.Contains(err.Error(), "invalid or expired token") {
		t.Errorf("error = %q, want 'invalid or expired token'", err.Error())
	}
	if user != nil {
		t.Errorf("user = %v, want nil", user)
	}
	if scopes != nil {
		t.Errorf("scopes = %v, want nil", scopes)
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — non-200, non-401 status
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_ServerError(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusInternalServerError,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("internal server error body")),
		}, nil
	})

	_, _, err := c.ValidateToken(context.Background(), "any-token")

	if err == nil {
		t.Fatal("ValidateToken: want error for 500, got nil")
	}
	if !strings.Contains(err.Error(), "GitHub API error") {
		t.Errorf("error = %q, want it to contain 'GitHub API error'", err.Error())
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error = %q, want it to mention status 500", err.Error())
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — empty X-OAuth-Scopes header
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_EmptyScopes(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		// No X-OAuth-Scopes header at all
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       jsonBody(githubResponse{Login: "noScopes"}),
		}, nil
	})

	user, scopes, err := c.ValidateToken(context.Background(), "token")

	if err != nil {
		t.Fatalf("ValidateToken: unexpected error: %v", err)
	}
	if user.Login != "noScopes" {
		t.Errorf("user.Login = %q, want %q", user.Login, "noScopes")
	}
	if len(scopes) != 0 {
		t.Errorf("scopes = %v, want empty slice", scopes)
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — scope header with extra whitespace
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_ScopesAreTrimmed(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		h := make(http.Header)
		h.Set("X-OAuth-Scopes", "  repo ,  gist ,  ")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     h,
			Body:       jsonBody(githubResponse{Login: "alice"}),
		}, nil
	})

	_, scopes, err := c.ValidateToken(context.Background(), "token")

	if err != nil {
		t.Fatalf("ValidateToken: unexpected error: %v", err)
	}
	want := []string{"repo", "gist"}
	if len(scopes) != len(want) {
		t.Fatalf("scopes = %v, want %v", scopes, want)
	}
	for i, s := range scopes {
		if s != want[i] {
			t.Errorf("scopes[%d] = %q, want %q", i, s, want[i])
		}
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — malformed JSON body
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_MalformedBody(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("{not valid json")),
		}, nil
	})

	_, _, err := c.ValidateToken(context.Background(), "token")

	if err == nil {
		t.Fatal("ValidateToken: want error for malformed JSON, got nil")
	}
	if !strings.Contains(err.Error(), "failed to parse GitHub response") {
		t.Errorf("error = %q, want 'failed to parse GitHub response'", err.Error())
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — transport-level error (e.g. no network)
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_TransportError(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("network unreachable")
	})

	_, _, err := c.ValidateToken(context.Background(), "token")

	if err == nil {
		t.Fatal("ValidateToken: want error for transport failure, got nil")
	}
	if !strings.Contains(err.Error(), "failed to call GitHub API") {
		t.Errorf("error = %q, want it to mention 'failed to call GitHub API'", err.Error())
	}
}

// ---------------------------------------------------------------------------
// ValidateToken — context cancellation surfaces as an error
// ---------------------------------------------------------------------------

func TestHttpGitHubClient_ValidateToken_CancelledContext(t *testing.T) {
	c := newMockedClient(func(r *http.Request) (*http.Response, error) {
		// Return context error to simulate cancellation propagation through the transport.
		return nil, r.Context().Err()
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := c.ValidateToken(ctx, "token")
	if err == nil {
		t.Fatal("ValidateToken: want error for cancelled context, got nil")
	}
}

// ---------------------------------------------------------------------------
// Constructor and interface compliance
// ---------------------------------------------------------------------------

func TestNewHttpGitHubClient_ImplementsInterface(t *testing.T) {
	c := NewHttpGitHubClient()
	if c == nil {
		t.Fatal("NewHttpGitHubClient returned nil")
	}
	// Compile-time check: assignment verifies the interface is satisfied.
	var _ ports.GitHubClient = c
}