package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runbookRequest is a test helper that creates a gin router with HandleRunbookRequest,
// fires a GET /runbook, and returns the parsed JSON response.
func runbookRequest(t *testing.T, cfg RunbookConfig) (int, map[string]interface{}) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/runbook", HandleRunbookRequest(cfg))

	req, err := http.NewRequest("GET", "/runbook", nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var response map[string]interface{}
	if w.Code == http.StatusOK {
		err = json.Unmarshal(w.Body.Bytes(), &response)
		require.NoError(t, err)
	}
	return w.Code, response
}

func TestHandleRunbookRequest(t *testing.T) {
	tempDir := t.TempDir()
	testContent := "This is test content for the runbook handler"
	testFile := filepath.Join(tempDir, "test-file.txt")
	require.NoError(t, os.WriteFile(testFile, []byte(testContent), 0644))

	t.Run("returns file content with full response shape", func(t *testing.T) {
		code, resp := runbookRequest(t, RunbookConfig{
			LocalPath:             testFile,
			UseExecutableRegistry: true,
		})

		assert.Equal(t, 200, code)
		assert.Equal(t, testContent, resp["content"])
		assert.Equal(t, testFile, resp["path"])
		assert.Equal(t, true, resp["useExecutableRegistry"])
		assert.NotEmpty(t, resp["contentHash"])
		assert.NotNil(t, resp["size"])
		// remoteSource and isWatchMode should be absent for a basic local runbook
		assert.Empty(t, resp["remoteSource"])
		assert.Empty(t, resp["isWatchMode"])
	})

	t.Run("file not found returns 404", func(t *testing.T) {
		code, _ := runbookRequest(t, RunbookConfig{
			LocalPath:             filepath.Join(tempDir, "non-existent.txt"),
			UseExecutableRegistry: true,
		})
		assert.Equal(t, 404, code)
	})

	t.Run("includes remoteSource when RemoteSourceURL is set", func(t *testing.T) {
		// RemoteSourceURL is provenance metadata passed through to the response as-is;
		// the handler never fetches it. The actual remote download happens upstream in remote_open.
		remoteURL := "https://github.com/org/repo/tree/main/runbooks/setup-vpc"
		code, resp := runbookRequest(t, RunbookConfig{
			LocalPath:             testFile,
			RemoteSourceURL:       remoteURL,
			UseExecutableRegistry: true,
		})

		assert.Equal(t, 200, code)
		assert.Equal(t, remoteURL, resp["remoteSource"])
	})

	t.Run("omits remoteSource for local runbooks", func(t *testing.T) {
		code, resp := runbookRequest(t, RunbookConfig{
			LocalPath:             testFile,
			UseExecutableRegistry: true,
		})

		assert.Equal(t, 200, code)
		assert.Empty(t, resp["remoteSource"], "remoteSource should not be in response for local runbooks")
	})

	t.Run("includes isWatchMode when enabled", func(t *testing.T) {
		code, resp := runbookRequest(t, RunbookConfig{
			LocalPath:             testFile,
			IsWatchMode:           true,
			UseExecutableRegistry: true,
		})

		assert.Equal(t, 200, code)
		assert.Equal(t, true, resp["isWatchMode"])
	})

	t.Run("includes warnings when UseExecutableRegistry is false", func(t *testing.T) {
		code, resp := runbookRequest(t, RunbookConfig{
			LocalPath:             testFile,
			UseExecutableRegistry: false,
		})

		assert.Equal(t, 200, code)
		assert.Equal(t, false, resp["useExecutableRegistry"])
		// warnings should be present (empty array for a plain text file)
		_, hasWarnings := resp["warnings"]
		assert.True(t, hasWarnings, "warnings should be present when UseExecutableRegistry is false")
	})
}

func TestHandleFileRequest(t *testing.T) {
	tempDir := t.TempDir()
	testContent := "This is test content for the file handler"
	testFile := filepath.Join(tempDir, "test-file.txt")
	require.NoError(t, os.WriteFile(testFile, []byte(testContent), 0644))
	runbookPath := filepath.Join(tempDir, "runbook.mdx")

	t.Run("serves file at runbook path directly", func(t *testing.T) {
		code, body := fileRequest(t, testFile, `{"path": ""}`)
		assert.Equal(t, 200, code)
		assert.Contains(t, body, testContent)
	})

	t.Run("resolves relative path from runbook directory", func(t *testing.T) {
		code, body := fileRequest(t, runbookPath, `{"path": "test-file.txt"}`)
		assert.Equal(t, 200, code)
		assert.Contains(t, body, testContent)
	})

	t.Run("returns 404 for non-existent file", func(t *testing.T) {
		code, _ := fileRequest(t, runbookPath, `{"path": "non-existent.txt"}`)
		assert.Equal(t, 404, code)
	})

	t.Run("returns 400 for invalid JSON", func(t *testing.T) {
		code, body := fileRequest(t, runbookPath, `{"path": "test"`)
		assert.Equal(t, 400, code)
		assert.Contains(t, body, "Invalid request")
	})

	t.Run("returns 400 for wrong type", func(t *testing.T) {
		code, body := fileRequest(t, runbookPath, `{"path": 123}`)
		assert.Equal(t, 400, code)
		assert.Contains(t, body, "Invalid request")
	})
}

// fileRequest is a test helper that creates a gin router with HandleFileRequest,
// fires a POST /file with the given raw JSON body, and returns the status code and body string.
func fileRequest(t *testing.T, runbookPath string, rawJSON string) (int, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/file", HandleFileRequest(runbookPath))

	req, err := http.NewRequest("POST", "/file", bytes.NewBufferString(rawJSON))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func TestHandleFileRequest_PermissionError(t *testing.T) {
	tempDir := t.TempDir()
	runbookPath := filepath.Join(tempDir, "runbook.mdx")

	unreadableFile := filepath.Join(tempDir, "secret.txt")
	require.NoError(t, os.WriteFile(unreadableFile, []byte("secret"), 0644))
	require.NoError(t, os.Chmod(unreadableFile, 0000))
	t.Cleanup(func() { os.Chmod(unreadableFile, 0644) })

	code, body := fileRequest(t, runbookPath, `{"path": "secret.txt"}`)
	assert.Equal(t, 500, code)
	assert.Contains(t, body, "Failed to read file")
}

func TestResolveRunbookPath(t *testing.T) {
	t.Run("directory containing runbook.mdx returns the file path", func(t *testing.T) {
		dir := t.TempDir()
		mdxPath := filepath.Join(dir, "runbook.mdx")
		require.NoError(t, os.WriteFile(mdxPath, []byte("# Hello"), 0644))

		result, err := ResolveRunbookPath(dir)
		require.NoError(t, err)
		assert.Equal(t, mdxPath, result)
	})

	t.Run("directory without runbook.mdx returns error", func(t *testing.T) {
		dir := t.TempDir()

		_, err := ResolveRunbookPath(dir)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "no runbook found")
		assert.Contains(t, err.Error(), "expected runbook.mdx")
	})

	t.Run("file path is returned as-is", func(t *testing.T) {
		dir := t.TempDir()
		filePath := filepath.Join(dir, "custom-name.mdx")
		require.NoError(t, os.WriteFile(filePath, []byte("# Hello"), 0644))

		result, err := ResolveRunbookPath(filePath)
		require.NoError(t, err)
		assert.Equal(t, filePath, result)
	})

	t.Run("nonexistent path returns error", func(t *testing.T) {
		_, err := ResolveRunbookPath("/nonexistent/path")
		assert.Error(t, err)
	})

	t.Run("runbook.md is not accepted", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "runbook.md"), []byte("# Hello"), 0644))

		_, err := ResolveRunbookPath(dir)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "no runbook found")
	})
}

func TestHandleRunbookAssetsRequest(t *testing.T) {
	tempDir := t.TempDir()

	runbookPath := filepath.Join(tempDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte("# Test Runbook"), 0644))

	assetsDir := filepath.Join(tempDir, "assets")
	require.NoError(t, os.Mkdir(assetsDir, 0755))

	imageContent := []byte("fake png content")
	require.NoError(t, os.WriteFile(filepath.Join(assetsDir, "test-image.png"), imageContent, 0644))

	pdfContent := []byte("fake pdf content")
	require.NoError(t, os.WriteFile(filepath.Join(assetsDir, "test-doc.pdf"), pdfContent, 0644))

	subDir := filepath.Join(assetsDir, "images")
	require.NoError(t, os.Mkdir(subDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(subDir, "nested-image.jpg"), []byte("nested image"), 0644))

	require.NoError(t, os.WriteFile(filepath.Join(assetsDir, "bad-script.sh"), []byte("#!/bin/bash"), 0644))

	// Create a file outside assets directory that should not be accessible
	require.NoError(t, os.WriteFile(filepath.Join(tempDir, "secret.txt"), []byte("secret data"), 0644))

	tests := []struct {
		name                string
		requestPath         string
		expectedStatus      int
		expectedContent     []byte
		expectedContentType string
		errorContains       string
	}{
		// Happy paths: serve allowed file types with correct content-type
		{"serve PNG image", "/test-image.png", 200, imageContent, "image/png", ""},
		{"serve PDF document", "/test-doc.pdf", 200, pdfContent, "application/pdf", ""},
		{"serve file from subdirectory", "/images/nested-image.jpg", 200, []byte("nested image"), "image/jpeg", ""},

		// Security: extension whitelist blocks disallowed types
		{"block script file", "/bad-script.sh", 403, nil, "", "File type not allowed"},

		// Security: path traversal prevention
		{"block directory traversal", "/../runbook.mdx", 403, nil, "", "Invalid path"},
		{"block encoded traversal", "/%2e%2e/secret.txt", 403, nil, "", "Invalid path"},

		// Error cases
		{"file not found", "/nonexistent.png", 404, nil, "", "File not found"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.GET("/runbook-assets/*filepath", HandleRunbookAssetsRequest(runbookPath))

			req, err := http.NewRequest("GET", "/runbook-assets"+tt.requestPath, nil)
			require.NoError(t, err)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, tt.expectedStatus, w.Code)

			if tt.errorContains != "" {
				assert.Contains(t, w.Body.String(), tt.errorContains)
			} else {
				assert.Equal(t, tt.expectedContent, w.Body.Bytes())
				assert.Equal(t, tt.expectedContentType, w.Header().Get("Content-Type"))
			}
		})
	}
}
