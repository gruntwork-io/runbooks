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
