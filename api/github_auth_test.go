package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestProtectedGitHubEndpointsRequireAuth verifies that the protected GitHub endpoints
// reject requests without a valid Authorization header.
func TestProtectedGitHubEndpointsRequireAuth(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)

	endpoints := []struct {
		name string
		path string
		body interface{}
	}{
		{
			name: "/api/github/oauth/poll",
			path: "/api/github/oauth/poll",
			body: GitHubOAuthPollRequest{ClientID: "test", DeviceCode: "test"},
		},
		{
			name: "/api/github/env-credentials",
			path: "/api/github/env-credentials",
			body: GitHubEnvCredentialsRequest{GitHubAuthID: "test"},
		},
		{
			name: "/api/github/cli-credentials",
			path: "/api/github/cli-credentials",
			body: struct{ GitHubAuthID string }{GitHubAuthID: "test"},
		},
	}

	for _, ep := range endpoints {
		t.Run(ep.name+" without auth returns 401", func(t *testing.T) {
			bodyBytes, _ := json.Marshal(ep.body)
			req := httptest.NewRequest(http.MethodPost, ep.path, bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			// No Authorization header

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Errorf("Expected status 401, got %d. Body: %s", w.Code, w.Body.String())
			}

			// Verify the error message mentions authorization
			var resp map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err == nil {
				if errMsg, ok := resp["error"].(string); ok {
					if errMsg == "" {
						t.Error("Expected error message in response")
					}
				}
			}
		})

		t.Run(ep.name+" with invalid token returns 401", func(t *testing.T) {
			bodyBytes, _ := json.Marshal(ep.body)
			req := httptest.NewRequest(http.MethodPost, ep.path, bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer invalid-token-12345")

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Errorf("Expected status 401, got %d. Body: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestProtectedGitHubEndpointsAcceptValidToken verifies that requests with a valid
// session token pass the auth middleware (they may still fail for other reasons
// like invalid GitHub credentials, but they should get past auth).
func TestProtectedGitHubEndpointsAcceptValidToken(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sessionResp, err := sm.CreateSession(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	router := setupTestRouter(t, sm)

	endpoints := []struct {
		name string
		path string
		body interface{}
	}{
		{
			name: "/api/github/oauth/poll",
			path: "/api/github/oauth/poll",
			body: GitHubOAuthPollRequest{ClientID: "test", DeviceCode: "test"},
		},
		{
			name: "/api/github/env-credentials",
			path: "/api/github/env-credentials",
			body: GitHubEnvCredentialsRequest{GitHubAuthID: "test"},
		},
		{
			name: "/api/github/cli-credentials",
			path: "/api/github/cli-credentials",
			body: struct{ GitHubAuthID string }{GitHubAuthID: "test"},
		},
	}

	for _, ep := range endpoints {
		t.Run(ep.name+" with valid token passes auth", func(t *testing.T) {
			bodyBytes, _ := json.Marshal(ep.body)
			req := httptest.NewRequest(http.MethodPost, ep.path, bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+sessionResp.Token)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			// Should NOT be 401 - the request passed auth middleware
			// It may fail for other reasons (e.g., GitHub API errors), but that's fine
			if w.Code == http.StatusUnauthorized {
				t.Errorf("Request with valid token should not return 401. Got body: %s", w.Body.String())
			}
		})
	}
}

// TestPublicGitHubEndpointsNoAuthRequired verifies that public GitHub endpoints
// work without authentication.
func TestPublicGitHubEndpointsNoAuthRequired(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)

	endpoints := []struct {
		name   string
		method string
		path   string
		body   interface{}
	}{
		{
			name:   "/api/github/validate",
			method: http.MethodPost,
			path:   "/api/github/validate",
			body:   GitHubValidateRequest{Token: "test-token"},
		},
		{
			name:   "/api/github/oauth/start",
			method: http.MethodPost,
			path:   "/api/github/oauth/start",
			body:   GitHubOAuthStartRequest{ClientID: "test-client-id", Scopes: []string{"repo"}},
		},
	}

	for _, ep := range endpoints {
		t.Run(ep.name+" works without auth", func(t *testing.T) {
			bodyBytes, _ := json.Marshal(ep.body)
			req := httptest.NewRequest(ep.method, ep.path, bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			// No Authorization header

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			// Should NOT be 401 - these are public endpoints
			// They may return other errors (e.g., invalid token), but not auth errors
			if w.Code == http.StatusUnauthorized {
				t.Errorf("Public endpoint should not require auth. Got 401 with body: %s", w.Body.String())
			}
		})
	}
}

// TestIsDefaultGitHubOAuthClientID verifies the helper function works correctly.
func TestIsDefaultGitHubOAuthClientID(t *testing.T) {
	tests := []struct {
		name     string
		clientID string
		expected bool
	}{
		{"empty string is default", "", true},
		{"default constant is default", DefaultGitHubOAuthClientID, true},
		{"custom client ID is not default", "Ov23liCustomClientId", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := IsDefaultGitHubOAuthClientID(tc.clientID)
			if result != tc.expected {
				t.Errorf("IsDefaultGitHubOAuthClientID(%q) = %v, want %v", tc.clientID, result, tc.expected)
			}
		})
	}
}

// TestParseGitHubCliScopes verifies the scope parsing regex works correctly
// with various gh auth status output formats.
func TestParseGitHubCliScopes(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{
			name: "standard output with multiple scopes",
			input: `github.com
  ✓ Logged in to github.com account josh-padnick (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`,
			expected: []string{"gist", "read:org", "repo", "workflow"},
		},
		{
			name: "single scope",
			input: `github.com
  ✓ Logged in to github.com account user (keyring)
  - Token scopes: 'repo'`,
			expected: []string{"repo"},
		},
		{
			name: "scopes without quotes",
			input: `github.com
  - Token scopes: repo, gist, read:org`,
			expected: []string{"repo", "gist", "read:org"},
		},
		{
			name: "singular Token scope (no s)",
			input: `github.com
  - Token scope: 'repo'`,
			expected: []string{"repo"},
		},
		{
			name: "no scopes line returns nil",
			input: `github.com
  ✓ Logged in to github.com account user (keyring)
  - Active account: true`,
			expected: nil,
		},
		{
			name:     "empty input returns nil",
			input:    "",
			expected: nil,
		},
		{
			name: "scopes with double quotes",
			input: `github.com
  - Token scopes: "repo", "gist"`,
			expected: []string{"repo", "gist"},
		},
		{
			name: "mixed quotes",
			input: `github.com
  - Token scopes: 'repo', "gist", read:org`,
			expected: []string{"repo", "gist", "read:org"},
		},
		{
			name: "scopes with extra whitespace",
			input: `github.com
  - Token scopes:   'repo'  ,  'gist'  ,  'workflow'  `,
			expected: []string{"repo", "gist", "workflow"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := parseGitHubCliScopes(tc.input)

			// Handle nil vs empty slice comparison
			if tc.expected == nil {
				if result != nil {
					t.Errorf("parseGitHubCliScopes() = %v, want nil", result)
				}
				return
			}

			if len(result) != len(tc.expected) {
				t.Errorf("parseGitHubCliScopes() returned %d scopes, want %d. Got: %v, want: %v",
					len(result), len(tc.expected), result, tc.expected)
				return
			}

			for i, scope := range result {
				if scope != tc.expected[i] {
					t.Errorf("parseGitHubCliScopes()[%d] = %q, want %q", i, scope, tc.expected[i])
				}
			}
		})
	}
}

// TestGitHubCliCredentialsResponseMethods verifies the Found() and HasRepoScope() methods.
func TestGitHubCliCredentialsResponseMethods(t *testing.T) {
	t.Run("Found returns true when user is set and no error", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			User:   &GitHubUserInfo{Login: "testuser"},
			Scopes: []string{"repo"},
		}
		if !resp.Found() {
			t.Error("Found() should return true when user is set and no error")
		}
	})

	t.Run("Found returns false when user is nil", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			Scopes: []string{"repo"},
		}
		if resp.Found() {
			t.Error("Found() should return false when user is nil")
		}
	})

	t.Run("Found returns false when error is set", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			User:  &GitHubUserInfo{Login: "testuser"},
			Error: "some error",
		}
		if resp.Found() {
			t.Error("Found() should return false when error is set")
		}
	})

	t.Run("HasRepoScope returns true when repo scope present", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			Scopes: []string{"gist", "repo", "workflow"},
		}
		if !resp.HasRepoScope() {
			t.Error("HasRepoScope() should return true when repo scope is present")
		}
	})

	t.Run("HasRepoScope returns false when repo scope missing", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			Scopes: []string{"gist", "read:org"},
		}
		if resp.HasRepoScope() {
			t.Error("HasRepoScope() should return false when repo scope is missing")
		}
	})

	t.Run("HasRepoScope returns false when scopes is nil", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{}
		if resp.HasRepoScope() {
			t.Error("HasRepoScope() should return false when scopes is nil")
		}
	})

	t.Run("HasRepoScope returns false when scopes is empty", func(t *testing.T) {
		resp := GitHubCliCredentialsResponse{
			Scopes: []string{},
		}
		if resp.HasRepoScope() {
			t.Error("HasRepoScope() should return false when scopes is empty")
		}
	})
}

// TestIsAllowedGitHubEnvVar verifies the env var name validation.
func TestIsAllowedGitHubEnvVar(t *testing.T) {
	tests := []struct {
		name     string
		envVar   string
		expected bool
	}{
		// Valid cases
		{"GITHUB_TOKEN is allowed", "GITHUB_TOKEN", true},
		{"GH_TOKEN is allowed", "GH_TOKEN", true},
		{"prefixed GITHUB_TOKEN is allowed", "MY_GITHUB_TOKEN", true},
		{"prefixed GH_TOKEN is allowed", "MY_GH_TOKEN", true},
		{"multiple prefix parts allowed", "MY_APP_GITHUB_TOKEN", true},
		{"numeric prefix allowed", "APP2_GITHUB_TOKEN", true},
		{"underscore in prefix allowed", "MY_APP_2_GITHUB_TOKEN", true},

		// Invalid cases - arbitrary env vars
		{"empty string rejected", "", false},
		{"PATH rejected", "PATH", false},
		{"HOME rejected", "HOME", false},
		{"AWS_SECRET_ACCESS_KEY rejected", "AWS_SECRET_ACCESS_KEY", false},
		{"DATABASE_PASSWORD rejected", "DATABASE_PASSWORD", false},
		{"API_KEY rejected", "API_KEY", false},

		// Invalid cases - similar but not matching pattern
		{"lowercase github_token rejected", "github_token", false},
		{"lowercase gh_token rejected", "gh_token", false},
		{"GITHUB_TOKEN with suffix rejected", "GITHUB_TOKEN_OLD", false},
		{"GH_TOKEN with suffix rejected", "GH_TOKEN_BACKUP", false},
		{"partial match rejected", "MY_GITHUB", false},
		{"TOKEN alone rejected", "TOKEN", false},
		{"GITHUB alone rejected", "GITHUB", false},

		// Edge cases
		{"lowercase prefix rejected", "my_GITHUB_TOKEN", false},
		{"mixed case prefix rejected", "My_GITHUB_TOKEN", false},
		{"leading underscore rejected", "_GITHUB_TOKEN", false},
		{"double underscore allowed", "MY__GITHUB_TOKEN", true}, // Unusual but valid naming, still secure
		{"space in name rejected", "MY GITHUB_TOKEN", false},
		{"special chars rejected", "MY-GITHUB_TOKEN", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isAllowedGitHubEnvVar(tc.envVar)
			if result != tc.expected {
				t.Errorf("isAllowedGitHubEnvVar(%q) = %v, want %v", tc.envVar, result, tc.expected)
			}
		})
	}
}

// TestIsValidEnvVarPrefix verifies the prefix validation.
func TestIsValidEnvVarPrefix(t *testing.T) {
	tests := []struct {
		name     string
		prefix   string
		expected bool
	}{
		// Valid cases
		{"empty prefix is valid", "", true},
		{"simple prefix with underscore", "MY_", true},
		{"prefix without trailing underscore", "MY", true},
		{"multi-part prefix", "MY_APP_", true},
		{"prefix with numbers", "APP2_", true},
		{"all caps no underscore", "MYAPP", true},
		{"single letter", "M", true},

		// Invalid cases
		{"lowercase rejected", "my_", false},
		{"mixed case rejected", "My_", false},
		{"leading underscore rejected", "_MY", false},
		{"starts with number rejected", "2APP_", false},
		{"special chars rejected", "MY-APP_", false},
		{"space rejected", "MY APP_", false},
		{"dot rejected", "MY.APP_", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidEnvVarPrefix(tc.prefix)
			if result != tc.expected {
				t.Errorf("isValidEnvVarPrefix(%q) = %v, want %v", tc.prefix, result, tc.expected)
			}
		})
	}
}
