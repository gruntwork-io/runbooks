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

func TestHandleRunbookRequest(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()
	
	// Create a test file
	testFile := filepath.Join(tempDir, "test-file.txt")
	testContent := "This is test content for the runbook handler"
	err := os.WriteFile(testFile, []byte(testContent), 0644)
	require.NoError(t, err)

	tests := []struct {
		name           string
		runbookPath    string
		expectedStatus int
		expectError    bool
		expectedContent string
	}{
		{
			name:           "read runbook file directly",
			runbookPath:    testFile,
			expectedStatus: 200,
			expectError:    false,
			expectedContent: testContent,
		},
		{
			name:           "file not found",
			runbookPath:    filepath.Join(tempDir, "non-existent.txt"),
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
			router.GET("/runbook", HandleRunbookRequest(tt.runbookPath))

			// Create request
			req, err := http.NewRequest("GET", "/runbook", nil)
			require.NoError(t, err)

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
		requestPath    string
		expectedStatus int
		expectError    bool
		expectedContent string
	}{
		{
			name:           "read file using runbook path directly",
			runbookPath:    testFile,
			requestPath:    "",
			expectedStatus: 200,
			expectError:    false,
			expectedContent: testContent,
		},
		{
			name:           "read file using relative path",
			runbookPath:    runbookPath,
			requestPath:    "test-file.txt",
			expectedStatus: 200,
			expectError:    false,
			expectedContent: testContent,
		},
		{
			name:           "file not found - non-existent file",
			runbookPath:    runbookPath,
			requestPath:    "non-existent.txt",
			expectedStatus: 404,
			expectError:    true,
			expectedContent: "",
		},
		{
			name:           "file not found - empty path",
			runbookPath:    "",
			requestPath:    "",
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
			router.POST("/file", HandleFileRequest(tt.runbookPath))

			// Create request body
			requestBody := FileRequest{Path: tt.requestPath}
			bodyBytes, err := json.Marshal(requestBody)
			require.NoError(t, err)

			// Create request
			req, err := http.NewRequest("POST", "/file", bytes.NewBuffer(bodyBytes))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")

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
		requestPath    string
		expectedStatus int
		errorContains  string
	}{
		{
			name:           "access directory instead of file",
			runbookPath:    testDir,
			requestPath:    "",
			expectedStatus: 500, // io.ReadAll fails for directories, returns 500
			errorContains:  "Failed to read file",
		},
		{
			name:           "file path with invalid characters",
			runbookPath:    "/invalid/path/with/\x00/null",
			requestPath:    "",
			expectedStatus: 500, // os.Open fails for invalid paths, returns 500
			errorContains:  "Failed to open file",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.POST("/file", HandleFileRequest(tt.runbookPath))

			// Create request body
			requestBody := FileRequest{Path: tt.requestPath}
			bodyBytes, err := json.Marshal(requestBody)
			require.NoError(t, err)

			// Create request
			req, err := http.NewRequest("POST", "/file", bytes.NewBuffer(bodyBytes))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")

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
		requestPath    string
		expectedStatus int
		expectError    bool
	}{
		{
			name:           "file with special characters",
			runbookPath:    testFile,
			requestPath:    "",
			expectedStatus: 200,
			expectError:    false,
		},
		{
			name:           "empty file",
			runbookPath:    runbookPath,
			requestPath:    "empty-file.txt",
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
			router.POST("/file", HandleFileRequest(tt.runbookPath))

			// Create request body
			requestBody := FileRequest{Path: tt.requestPath}
			bodyBytes, err := json.Marshal(requestBody)
			require.NoError(t, err)

			// Create request
			req, err := http.NewRequest("POST", "/file", bytes.NewBuffer(bodyBytes))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")

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

func TestHandleFileRequest_InvalidRequestBody(t *testing.T) {
	// Create a temporary directory for test files
	tempDir := t.TempDir()
	runbookPath := filepath.Join(tempDir, "runbook.mdx")

	tests := []struct {
		name           string
		requestBody    string
		expectedStatus int
		errorContains  string
	}{
		{
			name:           "empty request body",
			requestBody:    "",
			expectedStatus: 400,
			errorContains:  "Invalid request",
		},
		{
			name:           "invalid JSON",
			requestBody:    `{"path": "test"`,
			expectedStatus: 400,
			errorContains:  "Invalid request",
		},
		{
			name:           "missing path field",
			requestBody:    `{}`,
			expectedStatus: 404,
			errorContains:  "File not found",
		},
		{
			name:           "path field not a string",
			requestBody:    `{"path": 123}`,
			expectedStatus: 400,
			errorContains:  "Invalid request",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.POST("/file", HandleFileRequest(runbookPath))

			// Create request
			req, err := http.NewRequest("POST", "/file", bytes.NewBufferString(tt.requestBody))
			require.NoError(t, err)
			req.Header.Set("Content-Type", "application/json")

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