package api

import (
	"testing"
)

func TestValidateOutputPath(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		expectError bool
		description string
	}{
		{
			name:        "valid relative path",
			path:        "prod",
			expectError: false,
			description: "Simple subdirectory name should be allowed",
		},
		{
			name:        "valid nested relative path",
			path:        "environments/prod",
			expectError: false,
			description: "Nested subdirectories should be allowed",
		},
		{
			name:        "reject absolute path - unix",
			path:        "/etc/passwd",
			expectError: true,
			description: "Absolute Unix paths should be rejected",
		},
		{
			name:        "reject absolute path - windows",
			path:        "C:\\Windows\\System32",
			expectError: true,
			description: "Absolute Windows paths should be rejected",
		},
		{
			name:        "reject directory traversal - simple",
			path:        "../secrets",
			expectError: true,
			description: "Simple directory traversal should be rejected",
		},
		{
			name:        "reject directory traversal - nested",
			path:        "../../etc/passwd",
			expectError: true,
			description: "Nested directory traversal should be rejected",
		},
		{
			name:        "reject directory traversal - middle",
			path:        "foo/../bar",
			expectError: true,
			description: "Directory traversal in the middle should be rejected",
		},
		{
			name:        "reject directory traversal - end",
			path:        "foo/bar/..",
			expectError: true,
			description: "Directory traversal at the end should be rejected",
		},
		{
			name:        "valid path with dots in name",
			path:        "my.folder/sub.dir",
			expectError: false,
			description: "Dots in folder names (not ..) should be allowed",
		},
		{
			name:        "empty path",
			path:        "",
			expectError: false,
			description: "Empty path should be allowed (will use default)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRelativePath(tt.path)
			
			if tt.expectError && err == nil {
				t.Errorf("Expected error for path %q but got none. %s", tt.path, tt.description)
			}
			
			if !tt.expectError && err != nil {
				t.Errorf("Expected no error for path %q but got: %v. %s", tt.path, err, tt.description)
			}
		})
	}
}

func TestContainsDirectoryTraversal(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		{
			name:     "no traversal - simple path",
			path:     "foo/bar",
			expected: false,
		},
		{
			name:     "no traversal - single dot",
			path:     "./foo",
			expected: false,
		},
		{
			name:     "traversal - double dot at start",
			path:     "../foo",
			expected: true,
		},
		{
			name:     "traversal - double dot in middle",
			path:     "foo/../bar",
			expected: true,
		},
		{
			name:     "traversal - double dot at end",
			path:     "foo/..",
			expected: true,
		},
		{
			name:     "traversal - just double dot",
			path:     "..",
			expected: true,
		},
		{
			name:     "no traversal - dots in filename",
			path:     "my.file.txt",
			expected: false,
		},
		{
			name:     "no traversal - dotdot in filename",
			path:     "foo/..bar",
			expected: false,
		},
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

func TestDetermineOutputDirectory(t *testing.T) {
	tests := []struct {
		name                 string
		cliOutputPath        string
		apiRequestOutputPath *string
		expectError          bool
		expectedPath         string
	}{
		{
			name:                 "absolute CLI path only",
			cliOutputPath:        "/tmp/output",
			apiRequestOutputPath: nil,
			expectError:          false,
			expectedPath:         "/tmp/output",
		},
		{
			name:                 "absolute CLI path with valid API subdirectory",
			cliOutputPath:        "/tmp/output",
			apiRequestOutputPath: strPtr("prod"),
			expectError:          false,
			expectedPath:         "/tmp/output/prod",
		},
		{
			name:                 "reject API path with directory traversal",
			cliOutputPath:        "/tmp/output",
			apiRequestOutputPath: strPtr("../secrets"),
			expectError:          true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := determineOutputDirectory(tt.cliOutputPath, tt.apiRequestOutputPath)

			if tt.expectError {
				if err == nil {
					t.Errorf("Expected error but got none")
				}
			} else {
				if err != nil {
					t.Errorf("Unexpected error: %v", err)
				}
				if tt.expectedPath != "" && result != tt.expectedPath {
					t.Errorf("Expected result to be %q, got %q", tt.expectedPath, result)
				}
			}
		})
	}
}

// Helper function to create string pointer
func strPtr(s string) *string {
	return &s
}

