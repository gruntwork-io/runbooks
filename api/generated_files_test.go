package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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
		// Valid paths (within CWD)
		{
			name:        "relative path within cwd",
			path:        "generated",
			shouldError: false,
			description: "Simple relative path should be allowed",
		},
		{
			name:        "nested relative path within cwd",
			path:        "build/output/generated",
			shouldError: false,
			description: "Nested relative path should be allowed",
		},
		{
			name:        "relative path with dot",
			path:        "./generated",
			shouldError: false,
			description: "Relative path with ./ prefix should be allowed",
		},
		{
			name:        "cwd itself",
			path:        ".",
			shouldError: false,
			description: "Current directory itself should be allowed",
		},
		{
			name:        "absolute path within cwd",
			path:        filepath.Join(cwd, "generated"),
			shouldError: false,
			description: "Absolute path within CWD should be allowed",
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
		{
			name:        "multiple parent traversals",
			path:        "../../..",
			shouldError: true,
			description: "Multiple parent traversals should be blocked",
		},
		{
			name:        "sneaky parent traversal",
			path:        "generated/../../other-project",
			shouldError: true,
			description: "Path that goes down then up should be blocked if it escapes CWD",
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
			err := validateOutputPathSafety(tt.path)
			
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
			err := validateOutputPathSafety(tt.path)
			
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
	err = validateOutputPathSafety(symlinkPath)
	if err == nil {
		t.Error("Expected error when trying to delete through symlink pointing outside CWD, but got none")
	} else {
		t.Logf("Successfully blocked symlink attack: %v", err)
	}
}

func TestValidatePathSafeToDelete_EmptyPath(t *testing.T) {
	err := validateOutputPathSafety("")
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
			err := validateOutputPathSafety(path)
			if err == nil {
				t.Errorf("Expected error for case variant %q, but got none", path)
			} else {
				t.Logf("Successfully caught case variant %q: %v", path, err)
			}
		})
	}
}

