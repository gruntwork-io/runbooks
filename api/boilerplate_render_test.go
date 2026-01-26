package api

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestRenderBoilerplateTemplate(t *testing.T) {
	// Get the test data directory (relative to project root)
	testDataDir := "../testdata/test-fixtures/runbooks/with-boilerplate/runbook"
	expectedDir := "../testdata/test-fixtures/runbooks/with-boilerplate/expected-outputs/dev"

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
	err = RenderBoilerplateTemplate(testDataDir, tempDir, variables)
	if err != nil {
		t.Fatalf("RenderBoilerplateTemplate failed: %v", err)
	}

	// Compare generated files with expected files
	compareDirectories(t, tempDir, expectedDir)
}

func TestRenderBoilerplateTemplateWithDifferentVariables(t *testing.T) {
	// Get the test data directory (relative to project root)
	testDataDir := "../testdata/test-fixtures/runbooks/with-boilerplate/runbook"
	expectedDir := "../testdata/test-fixtures/runbooks/with-boilerplate/expected-outputs/prod"

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
	err = RenderBoilerplateTemplate(testDataDir, tempDir, variables)
	if err != nil {
		t.Fatalf("RenderBoilerplateTemplate failed: %v", err)
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
		variables map[string]any
		expected  string
		wantErr   bool
	}{
		{
			name:    "simple variable substitution",
			content: "Hello {{ .Name }}!",
			variables: map[string]any{
				"Name": "World",
			},
			expected: "Hello World!",
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := RenderBoilerplateContent(tt.content, tt.variables)
			
			if (err != nil) != tt.wantErr {
				t.Errorf("RenderBoilerplateContent() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			
			if !tt.wantErr && result != tt.expected {
				t.Errorf("RenderBoilerplateContent() = %q, want %q", result, tt.expected)
			}
		})
	}
}
