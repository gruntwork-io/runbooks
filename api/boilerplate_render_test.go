package api

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestRenderBoilerplateTemplate(t *testing.T) {
	// Get the test data directory (relative to project root)
	testDataDir := "../testdata/runbook-with-boilerplate/runbook"
	expectedDir := "../testdata/runbook-with-boilerplate/expected-outputs/dev"

	// Check if test data exists
	if _, err := os.Stat(testDataDir); os.IsNotExist(err) {
		t.Skipf("Test data directory %s does not exist", testDataDir)
	}
	if _, err := os.Stat(expectedDir); os.IsNotExist(err) {
		t.Skipf("Expected directory %s does not exist", expectedDir)
	}

	// Create a temporary output directory
	tempDir, err := os.MkdirTemp("", "boilerplate-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Test variables
	variables := map[string]any{
		"AccountName":   "Test Account",
		"Environment":   "dev",
		"EnableLogging": true,
		"InstanceCount": 2,
		"Tags": map[string]any{
			"Project": "Test Project",
			"Owner":   "Test User",
		},
		"AllowedIPs": []any{"10.0.0.0/8", "192.168.1.0/24"},
	}

	// Test the render function
	err = renderBoilerplateTemplate(testDataDir, tempDir, variables)
	if err != nil {
		t.Fatalf("renderBoilerplateTemplate failed: %v", err)
	}

	// Compare generated files with expected files
	compareDirectories(t, tempDir, expectedDir)
}

func TestRenderBoilerplateTemplateWithDifferentVariables(t *testing.T) {
	// Get the test data directory (relative to project root)
	testDataDir := "../testdata/runbook-with-boilerplate/runbook"
	expectedDir := "../testdata/runbook-with-boilerplate/expected-outputs/prod"

	// Check if test data exists
	if _, err := os.Stat(testDataDir); os.IsNotExist(err) {
		t.Skipf("Test data directory %s does not exist", testDataDir)
	}
	if _, err := os.Stat(expectedDir); os.IsNotExist(err) {
		t.Skipf("Expected directory %s does not exist", expectedDir)
	}

	// Create a temporary output directory
	tempDir, err := os.MkdirTemp("", "boilerplate-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Test with different variables (EnableLogging = false, no AllowedIPs)
	variables := map[string]any{
		"AccountName":   "Production Account",
		"Environment":   "prod",
		"EnableLogging": false,
		"InstanceCount": 5,
		"Tags": map[string]any{
			"Environment": "production",
			"Team":        "Platform",
		},
		"AllowedIPs": []any{}, // Empty list
	}

	// Test the render function
	err = renderBoilerplateTemplate(testDataDir, tempDir, variables)
	if err != nil {
		t.Fatalf("renderBoilerplateTemplate failed: %v", err)
	}

	// Compare generated files with expected files
	compareDirectories(t, tempDir, expectedDir)
}

// compareDirectories compares the contents of two directories recursively
func compareDirectories(t *testing.T, actualDir, expectedDir string) {
	// Get list of files in expected directory
	expectedFiles, err := getFileList(expectedDir)
	if err != nil {
		t.Fatalf("Failed to get expected file list: %v", err)
	}

	// Get list of files in actual directory, filtering out expected-outputs
	actualFiles, err := getFileList(actualDir)
	if err != nil {
		t.Fatalf("Failed to get actual file list: %v", err)
	}

	// Check that all expected files exist in actual
	for _, expectedFile := range expectedFiles {
		if !slices.Contains(actualFiles, expectedFile) {
			t.Errorf("Expected file %s not found in generated output", expectedFile)
		}
	}

	// Check that no unexpected files exist in actual
	for _, actualFile := range actualFiles {
		if !slices.Contains(expectedFiles, actualFile) {
			t.Errorf("Unexpected file %s found in generated output", actualFile)
		}
	}

	// Compare file contents
	for _, filename := range expectedFiles {
		expectedPath := filepath.Join(expectedDir, filename)
		actualPath := filepath.Join(actualDir, filename)

		expectedContent, err := os.ReadFile(expectedPath)
		if err != nil {
			t.Errorf("Failed to read expected file %s: %v", filename, err)
			continue
		}

		actualContent, err := os.ReadFile(actualPath)
		if err != nil {
			t.Errorf("Failed to read actual file %s: %v", filename, err)
			continue
		}

		if string(expectedContent) != string(actualContent) {
			t.Errorf("File %s content differs from expected", filename)
		}
	}
}

// getFileList returns a list of all files in a directory recursively
func getFileList(dir string) ([]string, error) {
	var files []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			relPath, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			files = append(files, relPath)
		}
		return nil
	})
	return files, err
}

func TestConvertVariablesToCorrectTypes(t *testing.T) {
	// Mock variables from boilerplate config
	variablesInConfig := map[string]any{
		"StringVar": "string",
		"IntVar":    "int",
		"FloatVar":  "float",
		"BoolVar":   "bool",
		"ListVar":   "list",
		"MapVar":    "map",
		"EnumVar":   "enum",
	}

	// Test variables (JSON types)
	testVariables := map[string]any{
		"StringVar":  "hello",
		"IntVar":     float64(42), // JSON numbers come as float64
		"FloatVar":   float64(3.14),
		"BoolVar":    true,
		"ListVar":    []any{"a", "b", "c"},
		"MapVar":     map[string]any{"key": "value"},
		"EnumVar":    "option1",
		"UnknownVar": "should be passed through",
	}

	// This is a simplified test since we can't easily mock the boilerplate Variable interface
	// In a real test, we'd need to create mock Variable objects
	t.Logf("Test variables: %+v", testVariables)
	t.Logf("Config variables: %+v", variablesInConfig)

	// For now, just verify the function doesn't panic
	// A more comprehensive test would require mocking the boilerplate Variable interface
	_, err := convertVariablesToCorrectTypes(testVariables, nil)
	if err != nil {
		t.Errorf("convertVariablesToCorrectTypes failed: %v", err)
	}
}

func TestReadAllFilesInDirectory(t *testing.T) {
	// Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "read-files-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create test files
	testFiles := map[string]string{
		"file1.txt":         "content of file 1",
		"subdir/file2.txt":  "content of file 2",
		"subdir/file3.json": `{"key": "value"}`,
		"another/deep/file.md": "# Markdown content",
	}

	for relPath, content := range testFiles {
		fullPath := filepath.Join(tempDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("Failed to create directory for %s: %v", relPath, err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to write file %s: %v", relPath, err)
		}
	}

	// Test readAllFilesInDirectory
	files, err := readAllFilesInDirectory(tempDir)
	if err != nil {
		t.Fatalf("readAllFilesInDirectory failed: %v", err)
	}

	// Verify all files are present
	if len(files) != len(testFiles) {
		t.Errorf("Expected %d files, got %d", len(testFiles), len(files))
	}

	// Verify file contents
	for relPath, expectedContent := range testFiles {
		actualFile, exists := files[relPath]
		if !exists {
			t.Errorf("Expected file %s not found in result", relPath)
			continue
		}
		if actualFile.Content != expectedContent {
			t.Errorf("File %s content mismatch. Expected: %q, Got: %q", relPath, expectedContent, actualFile.Content)
		}
	}
}

func TestRenderBoilerplateContent(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		variables map[string]string
		expected  string
		wantErr   bool
	}{
		{
			name:    "simple variable substitution",
			content: "Hello {{ .Name }}!",
			variables: map[string]string{
				"Name": "World",
			},
			expected: "Hello World!",
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := renderBoilerplateContent(tt.content, tt.variables)
			
			if (err != nil) != tt.wantErr {
				t.Errorf("renderBoilerplateContent() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			
			if !tt.wantErr && result != tt.expected {
				t.Errorf("renderBoilerplateContent() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestIsRemoteTemplatePath(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		// Remote paths with explicit prefixes (should return true)
		{
			name:     "HTTPS GitHub URL",
			path:     "https://github.com/gruntwork-io/repo//templates/vpc",
			expected: true,
		},
		{
			name:     "HTTPS URL without double slash",
			path:     "https://github.com/org/repo",
			expected: true,
		},
		{
			name:     "HTTP URL",
			path:     "http://example.com/templates",
			expected: true,
		},
		{
			name:     "Git protocol with HTTPS",
			path:     "git::https://github.com/org/repo//templates",
			expected: true,
		},
		{
			name:     "Git protocol with SSH",
			path:     "git::git@github.com:org/repo.git//templates",
			expected: true,
		},
		{
			name:     "Git protocol with SSH no path",
			path:     "git::git@github.com:org/repo.git",
			expected: true,
		},
		{
			name:     "S3 protocol",
			path:     "s3::https://s3.amazonaws.com/bucket/template",
			expected: true,
		},
		{
			name:     "S3 protocol with region",
			path:     "s3::https://s3-us-west-2.amazonaws.com/mybucket/path",
			expected: true,
		},
		// Git hosting shorthand (OpenTofu/Terraform style)
		{
			name:     "GitHub shorthand",
			path:     "github.com/gruntwork-io/repo//templates/vpc",
			expected: true,
		},
		{
			name:     "GitHub shorthand with ref",
			path:     "github.com/org/repo//path?ref=v1.0.0",
			expected: true,
		},
		{
			name:     "GitLab shorthand",
			path:     "gitlab.com/org/repo//templates",
			expected: true,
		},
		{
			name:     "Bitbucket shorthand",
			path:     "bitbucket.org/org/repo//templates",
			expected: true,
		},
		// Local paths (should return false)
		{
			name:     "Relative path",
			path:     "templates/vpc",
			expected: false,
		},
		{
			name:     "Relative path with dot",
			path:     "./templates/vpc",
			expected: false,
		},
		{
			name:     "Relative path with parent dir",
			path:     "../templates/vpc",
			expected: false,
		},
		{
			name:     "Absolute path",
			path:     "/home/user/templates/vpc",
			expected: false,
		},
		{
			name:     "Windows-style absolute path",
			path:     "C:\\Users\\templates\\vpc",
			expected: false,
		},
		{
			name:     "Git SSH without git:: prefix (treated as local)",
			path:     "git@github.com:org/repo.git//templates",
			expected: false,
		},
		// Edge cases
		{
			name:     "Empty path",
			path:     "",
			expected: false,
		},
		{
			name:     "Path that contains https but doesn't start with it",
			path:     "my-https-template",
			expected: false,
		},
		{
			name:     "Path that contains git but doesn't start with it",
			path:     "my-git-template",
			expected: false,
		},
		{
			name:     "Path that contains github.com but doesn't start with it",
			path:     "my-github.com-template",
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := isRemoteTemplatePath(tt.path)
			if result != tt.expected {
				t.Errorf("isRemoteTemplatePath(%q) = %v, want %v", tt.path, result, tt.expected)
			}
		})
	}
}

func TestNormalizeRemoteTemplatePath(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		expected string
	}{
		// GitHub shorthand should be converted
		{
			name:     "GitHub shorthand",
			path:     "github.com/gruntwork-io/repo//templates/vpc",
			expected: "git::https://github.com/gruntwork-io/repo//templates/vpc",
		},
		{
			name:     "GitHub shorthand with ref",
			path:     "github.com/org/repo//path?ref=v1.0.0",
			expected: "git::https://github.com/org/repo//path?ref=v1.0.0",
		},
		// GitLab shorthand
		{
			name:     "GitLab shorthand",
			path:     "gitlab.com/org/repo//templates",
			expected: "git::https://gitlab.com/org/repo//templates",
		},
		// Bitbucket shorthand
		{
			name:     "Bitbucket shorthand",
			path:     "bitbucket.org/org/repo//templates",
			expected: "git::https://bitbucket.org/org/repo//templates",
		},
		// HTTPS URLs to git hosts should be converted
		{
			name:     "https://github.com converted to git::",
			path:     "https://github.com/org/repo//templates/vpc",
			expected: "git::https://github.com/org/repo//templates/vpc",
		},
		{
			name:     "https://github.com with ref converted to git::",
			path:     "https://github.com/gruntwork-io/terragrunt-scale-catalog//templates/boilerplate/aws/github/account?ref=v1.3.2",
			expected: "git::https://github.com/gruntwork-io/terragrunt-scale-catalog//templates/boilerplate/aws/github/account?ref=v1.3.2",
		},
		{
			name:     "https://gitlab.com converted to git::",
			path:     "https://gitlab.com/org/repo//templates",
			expected: "git::https://gitlab.com/org/repo//templates",
		},
		{
			name:     "https://bitbucket.org converted to git::",
			path:     "https://bitbucket.org/org/repo//templates",
			expected: "git::https://bitbucket.org/org/repo//templates",
		},
		// Already explicit - should be unchanged
		{
			name:     "git:: prefix unchanged",
			path:     "git::https://github.com/org/repo//templates",
			expected: "git::https://github.com/org/repo//templates",
		},
		{
			name:     "https:// to non-git host unchanged",
			path:     "https://example.com/template.tar.gz",
			expected: "https://example.com/template.tar.gz",
		},
		{
			name:     "s3:: prefix unchanged",
			path:     "s3::https://s3.amazonaws.com/bucket/template",
			expected: "s3::https://s3.amazonaws.com/bucket/template",
		},
		// Local paths - should be unchanged
		{
			name:     "Local path unchanged",
			path:     "templates/vpc",
			expected: "templates/vpc",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := normalizeRemoteTemplatePath(tt.path)
			if result != tt.expected {
				t.Errorf("normalizeRemoteTemplatePath(%q) = %q, want %q", tt.path, result, tt.expected)
			}
		})
	}
}
