package api

import (
	"testing"
)

// TestContainsPathTraversal tests the path traversal detection
func TestContainsPathTraversal(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		{"no traversal - simple path", "foo/bar", false},
		{"no traversal - single dot", "./foo", false},
		{"traversal - double dot at start", "../foo", true},
		{"traversal - double dot in middle", "foo/../bar", true},
		{"traversal - double dot at end", "foo/..", true},
		{"traversal - just double dot", "..", true},
		{"no traversal - dots in filename", "my.file.txt", false},
		{"no traversal - dotdot in filename", "foo/..bar", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ContainsPathTraversal(tt.path)
			if result != tt.expected {
				t.Errorf("ContainsPathTraversal(%q) = %v, want %v", tt.path, result, tt.expected)
			}
		})
	}
}

// TestIsAbsolutePath tests absolute path detection
func TestIsAbsolutePath(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		{"unix absolute", "/etc/passwd", true},
		{"unix root", "/", true},
		{"relative path", "foo/bar", false},
		{"dot relative", "./foo", false},
		{"windows absolute uppercase", "C:/Windows", true},
		{"windows absolute lowercase", "c:/users", true},
		{"windows style backslash", "C:\\Windows", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsAbsolutePath(tt.path)
			if result != tt.expected {
				t.Errorf("IsAbsolutePath(%q) = %v, want %v", tt.path, result, tt.expected)
			}
		})
	}
}

// TestValidateRelativePath tests the basic relative path validation
func TestValidateRelativePath(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		shouldError bool
	}{
		{"empty allowed", "", false},
		{"simple file", "file.txt", false},
		{"nested path", "src/app.py", false},
		{"absolute unix rejected", "/etc/passwd", true},
		{"absolute windows rejected", "C:/Windows", true},
		{"traversal rejected", "../secret", true},
		{"hidden traversal rejected", "foo/../bar", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRelativePath(tt.path)
			if tt.shouldError && err == nil {
				t.Errorf("Expected error for %q but got none", tt.path)
			}
			if !tt.shouldError && err != nil {
				t.Errorf("Expected no error for %q but got: %v", tt.path, err)
			}
		})
	}
}

// TestValidateRelativePathIn tests the full security validation for relative paths within a directory
func TestValidateRelativePathIn(t *testing.T) {
	baseDir := "/tmp/output"

	tests := []struct {
		name        string
		relPath     string
		shouldError bool
		description string
	}{
		// Valid paths
		{
			name:        "simple file",
			relPath:     "file.txt",
			shouldError: false,
			description: "Simple filename should be allowed",
		},
		{
			name:        "nested file",
			relPath:     "src/app.py",
			shouldError: false,
			description: "Nested path should be allowed",
		},
		{
			name:        "deeply nested",
			relPath:     "a/b/c/d/file.txt",
			shouldError: false,
			description: "Deeply nested path should be allowed",
		},
		{
			name:        "file with dots in name",
			relPath:     "config.prod.yml",
			shouldError: false,
			description: "Dots in filename should be allowed",
		},

		// Invalid paths - directory traversal
		{
			name:        "parent directory traversal",
			relPath:     "../secret.txt",
			shouldError: true,
			description: "Parent traversal should be blocked",
		},
		{
			name:        "hidden traversal in path",
			relPath:     "src/../../../etc/passwd",
			shouldError: true,
			description: "Hidden traversal in middle of path should be blocked",
		},
		{
			name:        "double dot only",
			relPath:     "..",
			shouldError: true,
			description: "Just .. should be blocked",
		},
		{
			name:        "traversal at end that stays within",
			relPath:     "src/subdir/..",
			shouldError: false, // This cleans to "src" which is still within the output dir
			description: "Traversal that stays within base dir is safe",
		},
		{
			name:        "multiple traversals",
			relPath:     "../../../../../../etc/passwd",
			shouldError: true,
			description: "Multiple traversals should be blocked",
		},

		// Invalid paths - absolute paths
		{
			name:        "unix absolute path",
			relPath:     "/etc/passwd",
			shouldError: true,
			description: "Unix absolute path should be blocked",
		},
		{
			name:        "windows absolute path",
			relPath:     "C:/Windows/System32/config",
			shouldError: true,
			description: "Windows absolute path should be blocked",
		},
		{
			name:        "windows drive letter lowercase",
			relPath:     "c:/Users/victim/secrets.txt",
			shouldError: true,
			description: "Windows path with lowercase drive should be blocked",
		},

		// Invalid paths - empty
		{
			name:        "empty path",
			relPath:     "",
			shouldError: true,
			description: "Empty path should be blocked",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRelativePathIn(tt.relPath, baseDir)

			if tt.shouldError && err == nil {
				t.Errorf("Expected error for %q but got none. %s", tt.relPath, tt.description)
			}

			if !tt.shouldError && err != nil {
				t.Errorf("Expected no error for %q but got: %v. %s", tt.relPath, err, tt.description)
			}

			if tt.shouldError && err != nil {
				t.Logf("OK: Blocked unsafe path %q: %v", tt.relPath, err)
			}
		})
	}
}

// TestIsContainedIn tests the simple containment check function
func TestIsContainedIn(t *testing.T) {
	tests := []struct {
		name      string
		path      string
		container string
		expected  bool
	}{
		// Valid cases - path is within container
		{"same directory", "/out", "/out", true},
		{"subdirectory", "/out/src", "/out", true},
		{"deeply nested", "/out/a/b/c/d", "/out", true},

		// Invalid cases - path is outside container
		{"parent directory", "/", "/out", false},
		{"sibling directory", "/other", "/out", false},
		{"partial name match", "/output", "/out", false}, // /output is not within /out
		{"traversal attempt", "/out/../etc", "/out", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsContainedIn(tt.path, tt.container)
			if result != tt.expected {
				t.Errorf("IsContainedIn(%q, %q) = %v, want %v",
					tt.path, tt.container, result, tt.expected)
			}
		})
	}
}

// TestIsFilesystemRoot tests the cross-platform root detection
func TestIsFilesystemRoot(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		{"unix root", "/", true},
		{"unix subdir", "/foo", false},
		{"relative path", "foo/bar", false},
		// "." returns true because filepath.Dir(".") == "." - this is expected
		// behavior and the loop handles it separately with dir != "."
		{"current dir", ".", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsFilesystemRoot(tt.path)
			if result != tt.expected {
				t.Errorf("IsFilesystemRoot(%q) = %v, want %v",
					tt.path, result, tt.expected)
			}
		})
	}
}

