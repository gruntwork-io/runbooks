package api

import (
	"bytes"
	"encoding/json"
	"io"
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
			router.GET("/runbook", HandleRunbookRequest(tt.runbookPath, false, true))

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

func TestHandleRunbookAssetsRequest(t *testing.T) {
	// Create a temporary directory structure for test files
	tempDir := t.TempDir()
	
	// Create a runbook file
	runbookPath := filepath.Join(tempDir, "runbook.mdx")
	err := os.WriteFile(runbookPath, []byte("# Test Runbook"), 0644)
	require.NoError(t, err)
	
	// Create assets directory
	assetsDir := filepath.Join(tempDir, "assets")
	err = os.Mkdir(assetsDir, 0755)
	require.NoError(t, err)
	
	// Create test image file
	imagePath := filepath.Join(assetsDir, "test-image.png")
	imageContent := []byte("fake png content")
	err = os.WriteFile(imagePath, imageContent, 0644)
	require.NoError(t, err)
	
	// Create test PDF file
	pdfPath := filepath.Join(assetsDir, "test-doc.pdf")
	pdfContent := []byte("fake pdf content")
	err = os.WriteFile(pdfPath, pdfContent, 0644)
	require.NoError(t, err)
	
	// Create a subdirectory in assets
	subDir := filepath.Join(assetsDir, "images")
	err = os.Mkdir(subDir, 0755)
	require.NoError(t, err)
	
	// Create file in subdirectory
	subImagePath := filepath.Join(subDir, "nested-image.jpg")
	err = os.WriteFile(subImagePath, []byte("nested image"), 0644)
	require.NoError(t, err)
	
	// Create a script file that should be blocked
	scriptPath := filepath.Join(assetsDir, "bad-script.sh")
	err = os.WriteFile(scriptPath, []byte("#!/bin/bash\necho 'bad'"), 0644)
	require.NoError(t, err)

	tests := []struct {
		name           string
		requestPath    string
		expectedStatus int
		expectedContent []byte
		expectedContentType string
		expectError    bool
		errorContains  string
	}{
		{
			name:           "serve PNG image",
			requestPath:    "/test-image.png",
			expectedStatus: 200,
			expectedContent: imageContent,
			expectedContentType: "image/png",
			expectError:    false,
		},
		{
			name:           "serve PDF document",
			requestPath:    "/test-doc.pdf",
			expectedStatus: 200,
			expectedContent: pdfContent,
			expectedContentType: "application/pdf",
			expectError:    false,
		},
		{
			name:           "serve file from subdirectory",
			requestPath:    "/images/nested-image.jpg",
			expectedStatus: 200,
			expectedContent: []byte("nested image"),
			expectedContentType: "image/jpeg",
			expectError:    false,
		},
		{
			name:           "block script file",
			requestPath:    "/bad-script.sh",
			expectedStatus: 403,
			expectError:    true,
			errorContains:  "File type not allowed",
		},
		{
			name:           "file not found",
			requestPath:    "/nonexistent.png",
			expectedStatus: 404,
			expectError:    true,
			errorContains:  "File not found",
		},
		{
			name:           "block directory traversal with ../",
			requestPath:    "/../runbook.mdx",
			expectedStatus: 403,
			expectError:    true,
			errorContains:  "Invalid path",
		},
		{
			name:           "block absolute path - blocked by extension check",
			requestPath:    "/etc/passwd",
			expectedStatus: 403,
			expectError:    true,
			errorContains:  "File type not allowed",
		},
		{
			name:           "request directory instead of file - blocked by extension check",
			requestPath:    "/images",
			expectedStatus: 403,
			expectError:    true,
			errorContains:  "File type not allowed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set up Gin router
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.GET("/runbook-assets/*filepath", HandleRunbookAssetsRequest(runbookPath))

			// Create request
			req, err := http.NewRequest("GET", "/runbook-assets"+tt.requestPath, nil)
			require.NoError(t, err)

			// Create response recorder
			w := httptest.NewRecorder()

			// Perform request
			router.ServeHTTP(w, req)

			// Check status code
			assert.Equal(t, tt.expectedStatus, w.Code, "Status code mismatch for %s", tt.name)

			if tt.expectError {
				// For error cases, check error message
				if tt.errorContains != "" {
					assert.Contains(t, w.Body.String(), tt.errorContains)
				}
			} else {
				// For success cases, check content and content type
				assert.Equal(t, tt.expectedContent, w.Body.Bytes())
				assert.Equal(t, tt.expectedContentType, w.Header().Get("Content-Type"))
			}
		})
	}
}

func TestIsAllowedAssetExtension(t *testing.T) {
	tests := []struct {
		filename string
		expected bool
	}{
		// Allowed image formats
		{"image.png", true},
		{"photo.jpg", true},
		{"photo.jpeg", true},
		{"animated.gif", true},
		{"vector.svg", true},
		{"image.webp", true},
		{"bitmap.bmp", true},
		{"favicon.ico", true},
		
		// Allowed document formats
		{"document.pdf", true},
		
		// Allowed media formats
		{"video.mp4", true},
		{"video.webm", true},
		{"audio.ogg", true},
		{"audio.mp3", true},
		{"audio.wav", true},
		{"audio.m4a", true},
		{"video.avi", true},
		{"video.mov", true},
		
		// Blocked script files
		{"script.sh", false},
		{"script.bash", false},
		{"script.py", false},
		{"script.js", false},
		{"script.ts", false},
		
		// Blocked executables
		{"program.exe", false},
		{"binary.bin", false},
		
		// Blocked config files
		{"config.yml", false},
		{"config.yaml", false},
		{"config.json", false},
		{"secrets.env", false},
		
		// Blocked source code
		{"code.go", false},
		{"code.rs", false},
		{"code.java", false},
		
		// Edge cases
		{"noextension", false},
		{"multiple.dots.png", true},
		{".hiddenfile.png", true},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			result := isAllowedAssetExtension(tt.filename)
			assert.Equal(t, tt.expected, result, "Extension check failed for %s", tt.filename)
		})
	}
}

func TestGetContentType(t *testing.T) {
	tests := []struct {
		filename    string
		expectedType string
	}{
		// Images
		{"image.png", "image/png"},
		{"photo.jpg", "image/jpeg"},
		{"photo.jpeg", "image/jpeg"},
		{"animated.gif", "image/gif"},
		{"vector.svg", "image/svg+xml"},
		{"image.webp", "image/webp"},
		{"bitmap.bmp", "image/bmp"},
		{"favicon.ico", "image/x-icon"},
		
		// Documents
		{"document.pdf", "application/pdf"},
		
		// Media
		{"video.mp4", "video/mp4"},
		{"video.webm", "video/webm"},
		{"audio.ogg", "video/ogg"},
		{"audio.mp3", "audio/mpeg"},
		{"audio.wav", "audio/wav"},
		{"audio.m4a", "audio/mp4"},
		{"video.avi", "video/x-msvideo"},
		{"video.mov", "video/quicktime"},
		
		// Unknown extension
		{"unknown.xyz", "application/octet-stream"},
		{"noextension", "application/octet-stream"},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			result := getContentType(tt.filename)
			assert.Equal(t, tt.expectedType, result, "Content type mismatch for %s", tt.filename)
		})
	}
}

func TestHandleRunbookAssetsRequest_SecurityValidation(t *testing.T) {
	// Create a temporary directory structure
	tempDir := t.TempDir()
	
	// Create a runbook file
	runbookPath := filepath.Join(tempDir, "runbook.mdx")
	err := os.WriteFile(runbookPath, []byte("# Test"), 0644)
	require.NoError(t, err)
	
	// Create assets directory with a test file
	assetsDir := filepath.Join(tempDir, "assets")
	err = os.Mkdir(assetsDir, 0755)
	require.NoError(t, err)
	
	imagePath := filepath.Join(assetsDir, "test.png")
	err = os.WriteFile(imagePath, []byte("image"), 0644)
	require.NoError(t, err)
	
	// Create a file outside assets directory that should not be accessible
	secretFile := filepath.Join(tempDir, "secret.txt")
	err = os.WriteFile(secretFile, []byte("secret data"), 0644)
	require.NoError(t, err)

	securityTests := []struct {
		name          string
		requestPath   string
		expectedStatus int
		errorContains string
	}{
		{
			name:          "attempt directory traversal to parent",
			requestPath:   "/../secret.txt",
			expectedStatus: 403,
			errorContains: "Invalid path",
		},
		{
			name:          "attempt directory traversal with encoded ..",
			requestPath:   "/%2e%2e/secret.txt",
			expectedStatus: 403,
			errorContains: "Invalid path",
		},
		{
			name:          "attempt to access file with absolute path - blocked by extension check",
			requestPath:   secretFile,
			expectedStatus: 403,
			errorContains: "File type not allowed",
		},
		{
			name:          "valid nested path",
			requestPath:   "/test.png",
			expectedStatus: 200,
			errorContains: "",
		},
	}

	for _, tt := range securityTests {
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
				responseBody, _ := io.ReadAll(w.Body)
				assert.Contains(t, string(responseBody), tt.errorContains)
			}
		})
	}
}