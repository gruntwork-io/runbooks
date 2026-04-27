package desktop

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
	handler, err := assetHandler()
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
