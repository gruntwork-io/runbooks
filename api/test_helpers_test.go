package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// postJSON is a test helper that sets up a gin router with a single POST route,
// sends a JSON request body, and returns the response status code and raw body.
func postJSON(t *testing.T, path string, handler gin.HandlerFunc, body interface{}) (int, []byte) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST(path, handler)

	jsonBody, err := json.Marshal(body)
	require.NoError(t, err)

	req, err := http.NewRequest("POST", path, bytes.NewBuffer(jsonBody))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	return w.Code, w.Body.Bytes()
}

// protectedEndpoint describes an endpoint that requires session auth.
type protectedEndpoint struct {
	Name   string
	Method string // defaults to POST if empty
	Path   string
	Body   interface{}
}

// assertEndpointsRequireAuth verifies that each endpoint rejects requests
// without a valid Authorization header (no token and invalid token both → 401).
func assertEndpointsRequireAuth(t *testing.T, router *gin.Engine, endpoints []protectedEndpoint) {
	t.Helper()
	for _, ep := range endpoints {
		method := ep.Method
		if method == "" {
			method = http.MethodPost
		}

		t.Run(ep.Name+" without auth returns 401", func(t *testing.T) {
			var req *http.Request
			if ep.Body != nil {
				bodyBytes, _ := json.Marshal(ep.Body)
				req = httptest.NewRequest(method, ep.Path, bytes.NewReader(bodyBytes))
			} else {
				req = httptest.NewRequest(method, ep.Path, nil)
			}
			req.Header.Set("Content-Type", "application/json")

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusUnauthorized, w.Code, "body: %s", w.Body.String())
		})

		t.Run(ep.Name+" with invalid token returns 401", func(t *testing.T) {
			var req *http.Request
			if ep.Body != nil {
				bodyBytes, _ := json.Marshal(ep.Body)
				req = httptest.NewRequest(method, ep.Path, bytes.NewReader(bodyBytes))
			} else {
				req = httptest.NewRequest(method, ep.Path, nil)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer invalid-token-12345")

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusUnauthorized, w.Code, "body: %s", w.Body.String())
		})
	}
}

// assertEndpointsAcceptValidToken verifies that each endpoint accepts a valid
// session token (the request may fail for other reasons, but not with 401).
// A fresh session is created per subtest because some handlers (e.g.,
// /api/session/reset, DELETE /api/session) destroy the session as a side effect.
func assertEndpointsAcceptValidToken(t *testing.T, sm *SessionManager, endpoints []protectedEndpoint) {
	t.Helper()
	for _, ep := range endpoints {
		method := ep.Method
		if method == "" {
			method = http.MethodPost
		}

		t.Run(ep.Name+" with valid token passes auth", func(t *testing.T) {
			tmpDir := t.TempDir()
			sessionResp, err := sm.CreateSession(tmpDir)
			require.NoError(t, err)
			router := setupTestRouter(t, sm)

			var req *http.Request
			if ep.Body != nil {
				bodyBytes, _ := json.Marshal(ep.Body)
				req = httptest.NewRequest(method, ep.Path, bytes.NewReader(bodyBytes))
			} else {
				req = httptest.NewRequest(method, ep.Path, nil)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+sessionResp.Token)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.NotEqual(t, http.StatusUnauthorized, w.Code, "valid token should not return 401. Body: %s", w.Body.String())
		})
	}
}
