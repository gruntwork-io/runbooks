package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// setupTestWorkingDir creates a temporary directory to simulate the working directory
// (the directory from which the user runs `runbooks open ...`). It changes to that directory
// and registers cleanup to restore the original working directory and remove the temp dir.
// Returns the absolute path to the working directory (with symlinks resolved).
func setupTestWorkingDir(t *testing.T) string {
	t.Helper()

	// Save original working directory
	originalWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get original working directory: %v", err)
	}

	// Create temp directory
	workingDir, err := os.MkdirTemp("", "runbooks-test-workdir-*")
	if err != nil {
		t.Fatalf("Failed to create temp working directory: %v", err)
	}

	// Resolve symlinks (macOS has /var -> /private/var symlink)
	workingDir, err = filepath.EvalSymlinks(workingDir)
	if err != nil {
		os.RemoveAll(workingDir)
		t.Fatalf("Failed to resolve symlinks in working directory: %v", err)
	}

	// Change to working directory
	if err := os.Chdir(workingDir); err != nil {
		os.RemoveAll(workingDir)
		t.Fatalf("Failed to chdir to working directory: %v", err)
	}

	// Register cleanup
	t.Cleanup(func() {
		os.Chdir(originalWd)
		os.RemoveAll(workingDir)
	})

	return workingDir
}

func TestValidatePathSafeToDelete(t *testing.T) {
	// Get current working directory for test setup
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get current working directory: %v", err)
	}

	tests := []struct {
		name        string
		path        string
		shouldError bool
		description string
	}{
		// Valid paths (absolute, within CWD)
		{
			name:        "absolute path within cwd",
			path:        filepath.Join(cwd, "generated"),
			shouldError: false,
			description: "Absolute path within CWD should be allowed",
		},
		{
			name:        "cwd itself absolute",
			path:        cwd,
			shouldError: false,
			description: "CWD itself should be allowed",
		},

		// Invalid paths (relative - function requires absolute)
		{
			name:        "relative path rejected",
			path:        "generated",
			shouldError: true,
			description: "Relative paths must be rejected (function requires absolute)",
		},
		{
			name:        "relative path with dot rejected",
			path:        "./generated",
			shouldError: true,
			description: "Relative paths with ./ must be rejected",
		},
		{
			name:        "dot rejected",
			path:        ".",
			shouldError: true,
			description: "Dot is relative and must be rejected",
		},

		// Invalid paths (outside CWD)
		{
			name:        "parent directory",
			path:        "..",
			shouldError: true,
			description: "Parent directory should be blocked",
		},
		{
			name:        "path with parent traversal",
			path:        "../other-project",
			shouldError: true,
			description: "Path using .. to escape CWD should be blocked",
		},

		// System directories (Unix)
		{
			name:        "root directory",
			path:        "/",
			shouldError: true,
			description: "Root directory should be blocked",
		},
		{
			name:        "etc directory",
			path:        "/etc",
			shouldError: true,
			description: "/etc directory should be blocked",
		},
	}

	// Add Windows-specific tests only on Windows
	if runtime.GOOS == "windows" {
		windowsTests := []struct {
			name        string
			path        string
			shouldError bool
			description string
		}{
			{
				name:        "windows c drive root",
				path:        "C:/",
				shouldError: true,
				description: "C:/ should be blocked on Windows",
			},
			{
				name:        "windows system directory",
				path:        "C:/Windows",
				shouldError: true,
				description: "C:/Windows should be blocked on Windows",
			},
			{
				name:        "windows program files",
				path:        "C:/Program Files",
				shouldError: true,
				description: "C:/Program Files should be blocked on Windows",
			},
			{
				name:        "windows users directory",
				path:        "C:/Users",
				shouldError: true,
				description: "C:/Users should be blocked on Windows",
			},
		}
		tests = append(tests, windowsTests...)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAbsolutePathInCwd(tt.path)
			
			if tt.shouldError && err == nil {
				t.Errorf("Expected error for path %q but got none. Description: %s", tt.path, tt.description)
			}
			
			if !tt.shouldError && err != nil {
				t.Errorf("Expected no error for path %q but got: %v. Description: %s", tt.path, err, tt.description)
			}

			// Log the error message for debugging (only when we expect an error)
			if tt.shouldError && err != nil {
				t.Logf("Got expected error for %q: %v", tt.path, err)
			}
		})
	}
}

func TestValidatePathSafeToDelete_AbsolutePaths(t *testing.T) {
	// Get the current working directory (where the test is running)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get current directory: %v", err)
	}

	// Create a subdirectory within the current working directory for testing
	testDir := filepath.Join(cwd, "test-delete-validation")
	if err := os.MkdirAll(testDir, 0755); err != nil {
		t.Fatalf("Failed to create test directory: %v", err)
	}
	defer os.RemoveAll(testDir) // Clean up after test

	tests := []struct {
		name        string
		path        string
		shouldError bool
	}{
		{
			name:        "absolute path within cwd",
			path:        testDir,
			shouldError: false,
		},
		{
			name:        "absolute path outside cwd",
			path:        filepath.Dir(cwd), // Parent of cwd
			shouldError: true,
		},
		{
			name:        "absolute path far outside cwd",
			path:        "/tmp/other-location",
			shouldError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAbsolutePathInCwd(tt.path)
			
			if tt.shouldError && err == nil {
				t.Errorf("Expected error for absolute path %q but got none", tt.path)
			}
			
			if !tt.shouldError && err != nil {
				t.Errorf("Expected no error for absolute path %q but got: %v", tt.path, err)
			}
		})
	}
}

func TestValidatePathSafeToDelete_SymlinkAttacks(t *testing.T) {
	// Skip on Windows as symlinks require special privileges
	if runtime.GOOS == "windows" {
		t.Skip("Skipping symlink tests on Windows")
	}

	// Get current working directory
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get current directory: %v", err)
	}

	// Create a directory outside CWD to link to (parent of CWD)
	outsideDir := filepath.Join(filepath.Dir(cwd), "outside-target-test")
	if err := os.MkdirAll(outsideDir, 0755); err != nil {
		t.Fatalf("Failed to create outside directory: %v", err)
	}
	defer os.RemoveAll(outsideDir)

	// Create a symlink within CWD pointing outside
	symlinkPath := filepath.Join(cwd, "malicious-link-test")
	if err := os.Symlink(outsideDir, symlinkPath); err != nil {
		t.Fatalf("Failed to create symlink: %v", err)
	}
	defer os.Remove(symlinkPath)

	// Try to delete through the symlink - should be blocked because it resolves outside CWD
	err = ValidateAbsolutePathInCwd(symlinkPath)
	if err == nil {
		t.Error("Expected error when trying to delete through symlink pointing outside CWD, but got none")
	} else {
		t.Logf("Successfully blocked symlink attack: %v", err)
	}
}

func TestValidatePathSafeToDelete_EmptyPath(t *testing.T) {
	err := ValidateAbsolutePathInCwd("")
	// Empty path should be explicitly rejected
	if err == nil {
		t.Error("Expected error for empty path, but got none")
	} else {
		t.Logf("Successfully rejected empty path: %v", err)
	}
}

func TestValidatePathSafeToDelete_CaseSensitivity(t *testing.T) {
	// Test that case variations of system directories are caught
	// This is important for case-insensitive filesystems (macOS, Windows)
	
	dangerousPaths := []string{
		"/ETC",      // Uppercase variation
		"/UsR",      // Mixed case
		"/VAR",      // Uppercase
	}

	// On Windows, test Windows-specific paths
	if runtime.GOOS == "windows" {
		dangerousPaths = append(dangerousPaths, []string{
			"c:/WINDOWS",
			"C:/windows",
			"c:/Program Files",
		}...)
	}

	for _, path := range dangerousPaths {
		t.Run("case_variant_"+strings.ReplaceAll(path, "/", "_"), func(t *testing.T) {
			err := ValidateAbsolutePathInCwd(path)
			if err == nil {
				t.Errorf("Expected error for case variant %q, but got none", path)
			} else {
				t.Logf("Successfully caught case variant %q: %v", path, err)
			}
		})
	}
}

// TestHandleGeneratedFilesCheck_OutputPaths tests that the handler returns correct
// absoluteOutputPath and relativeOutputPath values for different input configurations.
// It simulates a working directory (where the CLI was launched) and tests various
// configuredOutputPath values.
func TestHandleGeneratedFilesCheck_OutputPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	workingDir := setupTestWorkingDir(t)

	tests := []struct {
		name                 string
		configuredOutputPath string // The --output-path CLI flag value
		expectedRelative     string // Expected relativeOutputPath in response
		expectedAbsolute     string // Expected absoluteOutputPath in response (exact match)
	}{
		{
			name:                 "default generated path",
			configuredOutputPath: "generated",
			expectedRelative:     "generated",
			expectedAbsolute:     filepath.Join(workingDir, "generated"),
		},
		{
			name:                 "custom relative path",
			configuredOutputPath: "my-output",
			expectedRelative:     "my-output",
			expectedAbsolute:     filepath.Join(workingDir, "my-output"),
		},
		{
			name:                 "nested relative path",
			configuredOutputPath: "build/output/files",
			expectedRelative:     "build/output/files",
			expectedAbsolute:     filepath.Join(workingDir, "build/output/files"),
		},
		{
			name:                 "dot-prefixed relative path",
			configuredOutputPath: "./my-output",
			expectedRelative:     "./my-output",
			expectedAbsolute:     filepath.Join(workingDir, "my-output"),
		},
		{
			name:                 "current directory as output",
			configuredOutputPath: ".",
			expectedRelative:     ".",
			expectedAbsolute:     workingDir,
		},
		{
			name:                 "absolute path within working dir",
			configuredOutputPath: filepath.Join(workingDir, "abs-output"),
			expectedRelative:     filepath.Join(workingDir, "abs-output"),
			expectedAbsolute:     filepath.Join(workingDir, "abs-output"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			router := gin.New()
			router.GET("/api/generated-files/check", HandleGeneratedFilesCheck(workingDir, tt.configuredOutputPath))

			req, err := http.NewRequest("GET", "/api/generated-files/check", nil)
			if err != nil {
				t.Fatalf("Failed to create request: %v", err)
			}

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)

			if recorder.Code != http.StatusOK {
				t.Errorf("Expected status 200, got %d. Body: %s", recorder.Code, recorder.Body.String())
				return
			}

			var response GeneratedFilesCheckResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("Failed to parse response JSON: %v", err)
			}

			// Verify relativeOutputPath matches exactly
			if response.RelativeOutputPath != tt.expectedRelative {
				t.Errorf("RelativeOutputPath mismatch:\n  got:      %q\n  expected: %q",
					response.RelativeOutputPath, tt.expectedRelative)
			}

			// Verify absoluteOutputPath matches exactly
			if response.AbsoluteOutputPath != tt.expectedAbsolute {
				t.Errorf("AbsoluteOutputPath mismatch:\n  got:      %q\n  expected: %q",
					response.AbsoluteOutputPath, tt.expectedAbsolute)
			}

			// Verify absoluteOutputPath is actually an absolute path
			if !filepath.IsAbs(response.AbsoluteOutputPath) {
				t.Errorf("AbsoluteOutputPath %q is not an absolute path", response.AbsoluteOutputPath)
			}

			t.Logf("OK: workingDir=%q, configured=%q → relative=%q, absolute=%q",
				workingDir, tt.configuredOutputPath, response.RelativeOutputPath, response.AbsoluteOutputPath)
		})
	}
}

// TestHandleGeneratedFilesCheck_DefaultOutputPath tests that when the CLI default
// output path ("generated") is used, the handler works correctly.
// Note: The default value "generated" is set in cmd/root.go via the --output-path flag.
// This test verifies the handler correctly processes this default value.
func TestHandleGeneratedFilesCheck_DefaultOutputPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	workingDir := setupTestWorkingDir(t)

	// "generated" is the CLI default value (see cmd/root.go)
	const cliDefaultOutputPath = "generated"

	router := gin.New()
	router.GET("/api/generated-files/check", HandleGeneratedFilesCheck(workingDir, cliDefaultOutputPath))

	req, _ := http.NewRequest("GET", "/api/generated-files/check", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", recorder.Code, recorder.Body.String())
	}

	var response GeneratedFilesCheckResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	// Verify the relative path is exactly "generated" (the default)
	if response.RelativeOutputPath != cliDefaultOutputPath {
		t.Errorf("RelativeOutputPath should be %q (CLI default), got %q",
			cliDefaultOutputPath, response.RelativeOutputPath)
	}

	// Verify the absolute path is workingDir/generated
	expectedAbsolute := filepath.Join(workingDir, cliDefaultOutputPath)
	if response.AbsoluteOutputPath != expectedAbsolute {
		t.Errorf("AbsoluteOutputPath mismatch:\n  got:      %q\n  expected: %q",
			response.AbsoluteOutputPath, expectedAbsolute)
	}

	t.Logf("OK: CLI default 'generated' → relative=%q, absolute=%q",
		response.RelativeOutputPath, response.AbsoluteOutputPath)
}

// TestHandleGeneratedFilesCheck_InvalidAbsolutePaths tests that invalid absolute paths
// (malformed, path traversal attacks, paths outside working dir, etc.) return appropriate errors.
func TestHandleGeneratedFilesCheck_InvalidAbsolutePaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	workingDir := setupTestWorkingDir(t)

	// Create another directory OUTSIDE the working directory for testing
	outsideDir, err := os.MkdirTemp("", "runbooks-test-outside-*")
	if err != nil {
		t.Fatalf("Failed to create outside directory: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(outsideDir) })

	outsideDir, err = filepath.EvalSymlinks(outsideDir)
	if err != nil {
		t.Fatalf("Failed to resolve symlinks in outside directory: %v", err)
	}

	invalidPaths := []struct {
		name        string
		path        string
		shouldError bool
	}{
		// Path traversal attacks
		{
			name:        "path traversal attack with ..",
			path:        "../../../etc/passwd",
			shouldError: true,
		},
		{
			name:        "path traversal via absolute then ..",
			path:        filepath.Join(workingDir, "..", "escape-attempt"),
			shouldError: true,
		},
		{
			name:        "double dot at start",
			path:        "..",
			shouldError: true,
		},
		{
			name:        "hidden double dot in path",
			path:        "output/../../../tmp/evil",
			shouldError: true,
		},
		// Absolute paths outside working directory
		{
			name:        "absolute path to root",
			path:        "/",
			shouldError: true,
		},
		{
			name:        "absolute path to etc",
			path:        "/etc",
			shouldError: true,
		},
		{
			name:        "absolute path to /tmp",
			path:        "/tmp/some-output",
			shouldError: true,
		},
		{
			name:        "absolute path to different temp dir",
			path:        outsideDir,
			shouldError: true,
		},
		{
			name:        "absolute path to parent directory",
			path:        filepath.Dir(workingDir),
			shouldError: true,
		},
		// Valid edge cases
		{
			name:        "tilde expansion attempt",
			path:        "~/Desktop",
			shouldError: false, // ~ is not expanded by Go, treated as literal directory "~" - valid relative path
		},
	}

	for _, tt := range invalidPaths {
		t.Run(tt.name, func(t *testing.T) {
			router := gin.New()
			router.GET("/api/generated-files/check", HandleGeneratedFilesCheck(workingDir, tt.path))

			req, _ := http.NewRequest("GET", "/api/generated-files/check", nil)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)

			if tt.shouldError {
				if recorder.Code == http.StatusOK {
					t.Errorf("Expected error for invalid path %q, but got 200 OK", tt.path)
				} else {
					t.Logf("OK: Invalid path %q correctly rejected with status %d", tt.path, recorder.Code)
				}
			} else {
				if recorder.Code != http.StatusOK {
					t.Errorf("Expected success for path %q, but got status %d: %s",
						tt.path, recorder.Code, recorder.Body.String())
				}
			}
		})
	}
}

// TestHandleGeneratedFilesCheck_RelativePathPreserved verifies that the relativeOutputPath
// is exactly what was passed to the handler (the CLI --output-path value), not modified.
func TestHandleGeneratedFilesCheck_RelativePathPreserved(t *testing.T) {
	gin.SetMode(gin.TestMode)
	workingDir := setupTestWorkingDir(t)

	// These are various ways users might specify the output path via CLI
	testCases := []string{
		"generated",
		"./generated",
		"output/files",
		".",
		"my-custom-dir",
		"nested/deep/path",
	}

	for _, configuredPath := range testCases {
		t.Run(configuredPath, func(t *testing.T) {
			router := gin.New()
			router.GET("/api/generated-files/check", HandleGeneratedFilesCheck(workingDir, configuredPath))

			req, _ := http.NewRequest("GET", "/api/generated-files/check", nil)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)

			if recorder.Code != http.StatusOK {
				t.Errorf("Expected status 200, got %d", recorder.Code)
				return
			}

			var response GeneratedFilesCheckResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("Failed to parse response: %v", err)
			}

			// The relative path should be EXACTLY what was configured (unchanged)
			if response.RelativeOutputPath != configuredPath {
				t.Errorf("RelativeOutputPath was modified!\n  input:  %q\n  output: %q",
					configuredPath, response.RelativeOutputPath)
			}

			// The absolute path should be the working dir + the relative path
			expectedAbsolute := filepath.Join(workingDir, configuredPath)
			if configuredPath == "." {
				expectedAbsolute = workingDir
			} else if strings.HasPrefix(configuredPath, "./") {
				expectedAbsolute = filepath.Join(workingDir, configuredPath[2:])
			}

			if response.AbsoluteOutputPath != expectedAbsolute {
				t.Errorf("AbsoluteOutputPath mismatch:\n  got:      %q\n  expected: %q",
					response.AbsoluteOutputPath, expectedAbsolute)
			}
		})
	}
}

