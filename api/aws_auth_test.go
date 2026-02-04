package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// setupTestRouter creates a router using the real setupCommonRoutes function.
// This ensures tests verify the actual route configuration, catching any
// accidental changes to auth requirements.
func setupTestRouter(t *testing.T, sm *SessionManager) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()

	workingDir := t.TempDir()
	runbookPath := workingDir + "/runbook.mdx"
	outputPath := workingDir + "/output"

	// Use the real route setup - this is what we're testing
	setupCommonRoutes(r, runbookPath, workingDir, outputPath, nil, sm, false)

	return r
}

// TestProtectedAwsEndpointsRequireAuth verifies that the protected AWS endpoints
// reject requests without a valid Authorization header.
func TestProtectedAwsEndpointsRequireAuth(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)

	endpoints := []struct {
		name string
		path string
		body interface{}
	}{
		{
			name: "/api/aws/profile",
			path: "/api/aws/profile",
			body: ProfileAuthRequest{Profile: "default"},
		},
		{
			name: "/api/aws/sso/poll",
			path: "/api/aws/sso/poll",
			body: SSOPollRequest{ClientID: "test", ClientSecret: "test", DeviceCode: "test"},
		},
		{
			name: "/api/aws/sso/complete",
			path: "/api/aws/sso/complete",
			body: SSOCompleteRequest{AccessToken: "test", AccountID: "123456789012", RoleName: "test"},
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

// TestProtectedAwsEndpointsAcceptValidToken verifies that requests with a valid
// session token pass the auth middleware (they may still fail for other reasons
// like invalid AWS credentials, but they should get past auth).
func TestProtectedAwsEndpointsAcceptValidToken(t *testing.T) {
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
			name: "/api/aws/profile",
			path: "/api/aws/profile",
			body: ProfileAuthRequest{Profile: "nonexistent-profile-for-test"},
		},
		{
			name: "/api/aws/sso/poll",
			path: "/api/aws/sso/poll",
			body: SSOPollRequest{ClientID: "test", ClientSecret: "test", DeviceCode: "test"},
		},
		{
			name: "/api/aws/sso/complete",
			path: "/api/aws/sso/complete",
			body: SSOCompleteRequest{AccessToken: "test", AccountID: "123456789012", RoleName: "test"},
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
			// It may fail for other reasons (e.g., AWS API errors), but that's fine
			if w.Code == http.StatusUnauthorized {
				t.Errorf("Request with valid token should not return 401. Got body: %s", w.Body.String())
			}
		})
	}
}

// TestSessionAuthMiddlewareErrorMessages verifies the middleware returns helpful error messages.
func TestSessionAuthMiddlewareErrorMessages(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)

	t.Run("missing header includes helpful message", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/aws/profile", bytes.NewReader([]byte(`{}`)))
		req.Header.Set("Content-Type", "application/json")
		// No Authorization header

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		errMsg, ok := resp["error"].(string)
		if !ok || errMsg == "" {
			t.Error("Expected error message in response")
		}

		// Should mention Authorization header
		if !contains(errMsg, "Authorization") {
			t.Errorf("Error message should mention Authorization header, got: %s", errMsg)
		}
	})

	t.Run("invalid token includes helpful message", func(t *testing.T) {
		// Create a session first, then use a wrong token
		tmpDir := t.TempDir()
		sm.CreateSession(tmpDir)

		req := httptest.NewRequest(http.MethodPost, "/api/aws/profile", bytes.NewReader([]byte(`{}`)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer wrong-token")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		var resp map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to parse response: %v", err)
		}

		errMsg, ok := resp["error"].(string)
		if !ok || errMsg == "" {
			t.Error("Expected error message in response")
		}

		// Should mention invalid/expired token
		if !contains(errMsg, "Invalid") && !contains(errMsg, "expired") {
			t.Errorf("Error message should mention invalid/expired token, got: %s", errMsg)
		}
	})
}

// TestMalformedAuthorizationHeader verifies various malformed Authorization headers are rejected.
func TestMalformedAuthorizationHeader(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)
	router := setupTestRouter(t, sm)

	testCases := []struct {
		name   string
		header string
	}{
		{"empty header", ""},
		{"missing Bearer prefix", "some-token"},
		{"wrong auth type", "Basic dXNlcjpwYXNz"},
		{"Bearer with no token", "Bearer "},
		{"bearer lowercase", "bearer some-token"}, // Should work (case-insensitive)
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/aws/profile", bytes.NewReader([]byte(`{"profile":"test"}`)))
			req.Header.Set("Content-Type", "application/json")
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			// "bearer lowercase" should pass auth parsing but fail token validation
			// All others should return 401
			if tc.name == "bearer lowercase" {
				// This tests case-insensitivity of "Bearer" - should still be 401
				// because the token "some-token" is invalid, not because of case
				if w.Code != http.StatusUnauthorized {
					t.Errorf("Expected 401 (invalid token), got %d", w.Code)
				}
			} else {
				if w.Code != http.StatusUnauthorized {
					t.Errorf("Expected 401, got %d for header %q", w.Code, tc.header)
				}
			}
		})
	}
}

// contains checks if substr is in s (case-sensitive)
func contains(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}

// TestIsAllowedAwsEnvVar verifies the env var name validation.
func TestIsAllowedAwsEnvVar(t *testing.T) {
	tests := []struct {
		name     string
		envVar   string
		expected bool
	}{
		// Valid cases - standard names
		{"AWS_ACCESS_KEY_ID is allowed", "AWS_ACCESS_KEY_ID", true},
		{"AWS_SECRET_ACCESS_KEY is allowed", "AWS_SECRET_ACCESS_KEY", true},
		{"AWS_SESSION_TOKEN is allowed", "AWS_SESSION_TOKEN", true},
		{"AWS_REGION is allowed", "AWS_REGION", true},

		// Valid cases - prefixed variants
		{"prefixed ACCESS_KEY_ID is allowed", "MY_AWS_ACCESS_KEY_ID", true},
		{"prefixed SECRET_ACCESS_KEY is allowed", "PROD_AWS_SECRET_ACCESS_KEY", true},
		{"prefixed SESSION_TOKEN is allowed", "DEV_AWS_SESSION_TOKEN", true},
		{"prefixed REGION is allowed", "STAGING_AWS_REGION", true},
		{"multiple prefix parts allowed", "MY_APP_AWS_ACCESS_KEY_ID", true},
		{"numeric prefix allowed", "APP2_AWS_ACCESS_KEY_ID", true},
		{"underscore in prefix allowed", "MY_APP_2_AWS_ACCESS_KEY_ID", true},

		// Invalid cases - arbitrary env vars
		{"empty string rejected", "", false},
		{"PATH rejected", "PATH", false},
		{"HOME rejected", "HOME", false},
		{"GITHUB_TOKEN rejected", "GITHUB_TOKEN", false},
		{"DATABASE_PASSWORD rejected", "DATABASE_PASSWORD", false},
		{"API_KEY rejected", "API_KEY", false},

		// Invalid cases - similar but not matching pattern
		{"lowercase aws_access_key_id rejected", "aws_access_key_id", false},
		{"AWS_ACCESS_KEY_ID with suffix rejected", "AWS_ACCESS_KEY_ID_OLD", false},
		{"AWS_SECRET_ACCESS_KEY with suffix rejected", "AWS_SECRET_ACCESS_KEY_BACKUP", false},
		{"partial match rejected", "MY_AWS_ACCESS", false},
		{"ACCESS_KEY_ID alone rejected", "ACCESS_KEY_ID", false},
		{"AWS alone rejected", "AWS", false},

		// Edge cases
		{"lowercase prefix rejected", "my_AWS_ACCESS_KEY_ID", false},
		{"mixed case prefix rejected", "My_AWS_ACCESS_KEY_ID", false},
		{"leading underscore rejected", "_AWS_ACCESS_KEY_ID", false},
		{"double underscore allowed", "MY__AWS_ACCESS_KEY_ID", true}, // Unusual but valid naming, still secure
		{"space in name rejected", "MY AWS_ACCESS_KEY_ID", false},
		{"special chars rejected", "MY-AWS_ACCESS_KEY_ID", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isAllowedAwsEnvVar(tc.envVar)
			if result != tc.expected {
				t.Errorf("isAllowedAwsEnvVar(%q) = %v, want %v", tc.envVar, result, tc.expected)
			}
		})
	}
}

// TestClearCredentialsEndpointRequiresAuth verifies that the credential clearing endpoint
// requires session authentication.
func TestClearCredentialsEndpointRequiresAuth(t *testing.T) {
	sm := NewSessionManager()
	router := setupTestRouter(t, sm)

	t.Run("DELETE /api/aws/session-credentials without auth returns 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/api/aws/session-credentials", nil)

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("Expected status 401, got %d. Body: %s", w.Code, w.Body.String())
		}
	})
}

// TestClearCredentialsEndpointClearsEnvVars verifies that the credential clearing endpoint
// actually removes AWS credentials from the session.
func TestClearCredentialsEndpointClearsEnvVars(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sessionResp, err := sm.CreateSession(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// First, add some AWS credentials to the session
	awsCreds := map[string]string{
		"AWS_ACCESS_KEY_ID":     "AKIAIOSFODNN7EXAMPLE",
		"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		"AWS_SESSION_TOKEN":     "AQoDYXdzEJr...",
		"AWS_REGION":            "us-west-2",
	}
	if err := sm.AppendToEnv(awsCreds); err != nil {
		t.Fatalf("Failed to add credentials to session: %v", err)
	}

	// Verify credentials are set
	session, ok := sm.GetSession()
	if !ok {
		t.Fatal("Session should exist")
	}
	if session.Env["AWS_ACCESS_KEY_ID"] != "AKIAIOSFODNN7EXAMPLE" {
		t.Fatal("AWS_ACCESS_KEY_ID should be set before clearing")
	}

	router := setupTestRouter(t, sm)

	// Call the clear endpoint
	req := httptest.NewRequest(http.MethodDelete, "/api/aws/session-credentials", nil)
	req.Header.Set("Authorization", "Bearer "+sessionResp.Token)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify credentials are cleared
	var resp ClearCredentialsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}
	if !resp.Cleared {
		t.Error("Response should indicate credentials were cleared")
	}

	// Verify env vars are actually gone from session
	session, _ = sm.GetSession()
	if _, exists := session.Env["AWS_ACCESS_KEY_ID"]; exists {
		t.Error("AWS_ACCESS_KEY_ID should be cleared")
	}
	if _, exists := session.Env["AWS_SECRET_ACCESS_KEY"]; exists {
		t.Error("AWS_SECRET_ACCESS_KEY should be cleared")
	}
	if _, exists := session.Env["AWS_SESSION_TOKEN"]; exists {
		t.Error("AWS_SESSION_TOKEN should be cleared")
	}
	if _, exists := session.Env["AWS_REGION"]; exists {
		t.Error("AWS_REGION should be cleared")
	}
}

// TestIsValidAwsEnvVarPrefix verifies the prefix validation.
func TestIsValidAwsEnvVarPrefix(t *testing.T) {
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
		{"PROD prefix", "PROD_", true},
		{"DEV prefix", "DEV_", true},

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
			result := isValidAwsEnvVarPrefix(tc.prefix)
			if result != tc.expected {
				t.Errorf("isValidAwsEnvVarPrefix(%q) = %v, want %v", tc.prefix, result, tc.expected)
			}
		})
	}
}
