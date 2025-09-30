package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleFileRequest(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()
	
	// Create a test file
	testFile := filepath.Join(tempDir, "test-file.txt")
	testContent := "This is test content for the file handler"
	err := os.WriteFile(testFile, []byte(testContent), 0644)
	require.NoError(t, err)

	// Create a runbook file path (doesn't need to exist for this test)
	runbookPath := filepath.Join(tempDir, "runbook.mdx")

	tests := []struct {
		name           string
		runbookPath    string
		queryPath      string
		expectedStatus int
		expectError    bool
		expectedContent string
	}{
		{
			name:           "read file using runbook path directly",
			runbookPath:    testFile,
			queryPath:      "",
			expectedStatus: 200,
			expectError:    false,
			expectedContent: testContent,
		},
		{
			name:           "read file using relative path",
			runbookPath:    runbookPath,
			queryPath:      "test-file.txt",
			expectedStatus: 200,
			expectError:    false,
			expectedContent: testContent,
		},
		{
			name:           "file not found - non-existent file",
			runbookPath:    runbookPath,
			queryPath:      "non-existent.txt",
			expectedStatus: 404,
			expectError:    true,
			expectedContent: "",
		},
		{
			name:           "file not found - empty path",
			runbookPath:    "",
			queryPath:      "",
			expectedStatus: 404,
			expectError:    true,
			expectedContent: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.GET("/file", HandleFileRequest(tt.runbookPath))

			// Create request
			req, err := http.NewRequest("GET", "/file", nil)
			require.NoError(t, err)

			// Add query parameter if specified
			if tt.queryPath != "" {
				q := req.URL.Query()
				q.Add("path", tt.queryPath)
				req.URL.RawQuery = q.Encode()
			}

			// Create response recorder
			w := httptest.NewRecorder()

			// Perform request
			router.ServeHTTP(w, req)

			// Check status code
			assert.Equal(t, tt.expectedStatus, w.Code)

			if tt.expectError {
				// For error cases, check that we get an error response
				assert.Contains(t, w.Body.String(), "error")
			} else {
				// For success cases, check that we get the file content
				assert.Contains(t, w.Body.String(), tt.expectedContent)
				assert.Contains(t, w.Body.String(), "content")
			}
		})
	}
}

func TestHandleFileRequest_FileIOErrors(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()
	
	// Create a test file
	testFile := filepath.Join(tempDir, "test-file.txt")
	testContent := "This is test content"
	err := os.WriteFile(testFile, []byte(testContent), 0644)
	require.NoError(t, err)

	// Create a directory (not a file) to test directory access
	testDir := filepath.Join(tempDir, "test-dir")
	err = os.Mkdir(testDir, 0755)
	require.NoError(t, err)

	tests := []struct {
		name           string
		runbookPath    string
		queryPath      string
		expectedStatus int
		errorContains  string
	}{
		{
			name:           "access directory instead of file",
			runbookPath:    testDir,
			queryPath:      "",
			expectedStatus: 500, // io.ReadAll fails for directories, returns 500
			errorContains:  "Failed to read file",
		},
		{
			name:           "file path with invalid characters",
			runbookPath:    "/invalid/path/with/\x00/null",
			queryPath:      "",
			expectedStatus: 500, // os.Open fails for invalid paths, returns 500
			errorContains:  "Failed to open file",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.GET("/file", HandleFileRequest(tt.runbookPath))

			// Create request
			req, err := http.NewRequest("GET", "/file", nil)
			require.NoError(t, err)

			// Add query parameter if specified
			if tt.queryPath != "" {
				q := req.URL.Query()
				q.Add("path", tt.queryPath)
				req.URL.RawQuery = q.Encode()
			}

			// Create response recorder
			w := httptest.NewRecorder()

			// Perform request
			router.ServeHTTP(w, req)

			// Check status code
			assert.Equal(t, tt.expectedStatus, w.Code)

			if tt.errorContains != "" {
				assert.Contains(t, w.Body.String(), tt.errorContains)
			}
		})
	}
}

func TestHandleFileRequest_EdgeCases(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()
	
	// Create a test file with special content
	testFile := filepath.Join(tempDir, "special-file.txt")
	specialContent := "Content with special chars: \n\t\r\"'\\"
	err := os.WriteFile(testFile, []byte(specialContent), 0644)
	require.NoError(t, err)

	// Create a runbook file path
	runbookPath := filepath.Join(tempDir, "runbook.mdx")

	tests := []struct {
		name           string
		runbookPath    string
		queryPath      string
		expectedStatus int
		expectError    bool
	}{
		{
			name:           "file with special characters",
			runbookPath:    testFile,
			queryPath:      "",
			expectedStatus: 200,
			expectError:    false,
		},
		{
			name:           "empty file",
			runbookPath:    runbookPath,
			queryPath:      "empty-file.txt",
			expectedStatus: 200,
			expectError:    false,
		},
	}

	// Create an empty file for testing
	emptyFile := filepath.Join(tempDir, "empty-file.txt")
	err = os.WriteFile(emptyFile, []byte(""), 0644)
	require.NoError(t, err)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.GET("/file", HandleFileRequest(tt.runbookPath))

			// Create request
			req, err := http.NewRequest("GET", "/file", nil)
			require.NoError(t, err)

			// Add query parameter if specified
			if tt.queryPath != "" {
				q := req.URL.Query()
				q.Add("path", tt.queryPath)
				req.URL.RawQuery = q.Encode()
			}

			// Create response recorder
			w := httptest.NewRecorder()

			// Perform request
			router.ServeHTTP(w, req)

			// Check status code
			assert.Equal(t, tt.expectedStatus, w.Code)

			if !tt.expectError {
				// For success cases, check that we get a valid JSON response
				assert.Contains(t, w.Body.String(), "content")
				assert.Contains(t, w.Body.String(), "path")
			}
		})
	}
}
