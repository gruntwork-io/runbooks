package desktop

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/services"
)

// TestAssetHandlerFallbackToIndex verifies the handler serves the
// embedded index.html for paths that do not resolve to real files in
// the embedded dist tree. SPA client-side routing depends on this: a
// deep URL like /runbook/foo must yield the React shell so React
// Router can take over.
//
// The real web/dist tree is produced by `bun run build`, which isn't
// run in this unit test. We only assert that an unknown path returns
// HTTP 200 with a non-empty body — the exact markup is a property of
// whatever dist happens to be embedded when the test runs.
func TestAssetHandlerFallbackToIndex(t *testing.T) {
	svcs, err := services.NewServices("", adapters.NewNoopEmitter())
	if err != nil {
		t.Fatalf("NewServices: %v", err)
	}
	handler, err := assetHandler(svcs.Welcome)
	if err != nil {
		t.Fatalf("assetHandler returned error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/does/not/exist", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for unknown path (SPA fallback), got %d", rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatalf("expected non-empty fallback body, got empty")
	}
}

// TestAPIProxyReturns503WhenServerNotRunning verifies that API
// requests made before the backend starts (user still on Welcome)
// surface as 503 Service Unavailable rather than trying to contact a
// phantom upstream and timing out.
func TestAPIProxyReturns503WhenServerNotRunning(t *testing.T) {
	svcs, err := services.NewServices("", adapters.NewNoopEmitter())
	if err != nil {
		t.Fatalf("NewServices: %v", err)
	}
	handler, err := assetHandler(svcs.Welcome)
	if err != nil {
		t.Fatalf("assetHandler returned error: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/gruntbook", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when no gruntbook is open, got %d", rec.Code)
	}
}
