package api

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestHashFileContent verifies that content hashing produces consistent results
func TestHashFileContent(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{"empty content", []byte{}},
		{"simple text", []byte("hello world")},
		{"multiline", []byte("line1\nline2\nline3")},
		{"binary-like", []byte{0x00, 0x01, 0x02, 0xff}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hash1 := HashFileContent(tt.content)
			hash2 := HashFileContent(tt.content)

			if hash1 != hash2 {
				t.Errorf("Same content produced different hashes: %s vs %s", hash1, hash2)
			}

			if len(hash1) != 64 { // SHA256 produces 64 hex characters
				t.Errorf("Expected 64 character hash, got %d characters", len(hash1))
			}
		})
	}
}

// TestHashFileContent_DifferentContent verifies that different content produces different hashes
func TestHashFileContent_DifferentContent(t *testing.T) {
	hash1 := HashFileContent([]byte("content A"))
	hash2 := HashFileContent([]byte("content B"))

	if hash1 == hash2 {
		t.Error("Different content should produce different hashes")
	}
}

// TestBuildManifestFromDirectory verifies manifest building from a directory
func TestBuildManifestFromDirectory(t *testing.T) {
	// Create temp directory with test files
	tempDir, err := os.MkdirTemp("", "manifest-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create test files
	testFiles := map[string]string{
		"file1.txt":        "content of file 1",
		"subdir/file2.txt": "content of file 2",
		"subdir/file3.txt": "content of file 3",
	}

	for relPath, content := range testFiles {
		fullPath := filepath.Join(tempDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("Failed to create directory: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to write file: %v", err)
		}
	}

	// Build manifest
	entries, err := BuildManifestFromDirectory(tempDir)
	if err != nil {
		t.Fatalf("Failed to build manifest: %v", err)
	}

	// Verify correct number of entries
	if len(entries) != len(testFiles) {
		t.Errorf("Expected %d entries, got %d", len(testFiles), len(entries))
	}

	// Verify each file is present with correct hash
	entryMap := make(map[string]string)
	for _, e := range entries {
		entryMap[e.Path] = e.ContentHash
	}

	for relPath, content := range testFiles {
		hash, exists := entryMap[relPath]
		if !exists {
			t.Errorf("File %q missing from manifest", relPath)
			continue
		}

		expectedHash := HashFileContent([]byte(content))
		if hash != expectedHash {
			t.Errorf("Hash mismatch for %q: got %s, expected %s", relPath, hash, expectedHash)
		}
	}
}

// TestComputeDiff verifies the diff computation between manifests
func TestComputeDiff(t *testing.T) {
	tests := []struct {
		name            string
		oldEntries      []ManifestEntry
		newEntries      []ManifestEntry
		expectedOrphan  []string
		expectedCreated []string
		expectedMod     []string
		expectedUnch    []string
	}{
		{
			name:            "empty to empty",
			oldEntries:      []ManifestEntry{},
			newEntries:      []ManifestEntry{},
			expectedOrphan:  nil,
			expectedCreated: nil,
			expectedMod:     nil,
			expectedUnch:    nil,
		},
		{
			name:       "empty to some files",
			oldEntries: []ManifestEntry{},
			newEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash1"},
				{Path: "file2.txt", ContentHash: "hash2"},
			},
			expectedOrphan:  nil,
			expectedCreated: []string{"file1.txt", "file2.txt"},
			expectedMod:     nil,
			expectedUnch:    nil,
		},
		{
			name: "some files to empty",
			oldEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash1"},
				{Path: "file2.txt", ContentHash: "hash2"},
			},
			newEntries:      []ManifestEntry{},
			expectedOrphan:  []string{"file1.txt", "file2.txt"},
			expectedCreated: nil,
			expectedMod:     nil,
			expectedUnch:    nil,
		},
		{
			name: "same files same hashes",
			oldEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash1"},
			},
			newEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash1"},
			},
			expectedOrphan:  nil,
			expectedCreated: nil,
			expectedMod:     nil,
			expectedUnch:    []string{"file1.txt"},
		},
		{
			name: "same files different hashes",
			oldEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash1"},
			},
			newEntries: []ManifestEntry{
				{Path: "file1.txt", ContentHash: "hash2"},
			},
			expectedOrphan:  nil,
			expectedCreated: nil,
			expectedMod:     []string{"file1.txt"},
			expectedUnch:    nil,
		},
		{
			name: "runtime switch scenario (Python to Node.js)",
			oldEntries: []ManifestEntry{
				{Path: "terragrunt.hcl", ContentHash: "hcl-hash-v1"},
				{Path: "src/app.py", ContentHash: "python-hash"},
			},
			newEntries: []ManifestEntry{
				{Path: "terragrunt.hcl", ContentHash: "hcl-hash-v2"}, // Modified
				{Path: "src/index.mjs", ContentHash: "node-hash"},   // Created
			},
			expectedOrphan:  []string{"src/app.py"},      // Python file orphaned
			expectedCreated: []string{"src/index.mjs"},   // Node file created
			expectedMod:     []string{"terragrunt.hcl"},  // HCL modified
			expectedUnch:    nil,
		},
		{
			name: "mixed changes",
			oldEntries: []ManifestEntry{
				{Path: "keep.txt", ContentHash: "same"},
				{Path: "modify.txt", ContentHash: "old"},
				{Path: "delete.txt", ContentHash: "gone"},
			},
			newEntries: []ManifestEntry{
				{Path: "keep.txt", ContentHash: "same"},
				{Path: "modify.txt", ContentHash: "new"},
				{Path: "create.txt", ContentHash: "fresh"},
			},
			expectedOrphan:  []string{"delete.txt"},
			expectedCreated: []string{"create.txt"},
			expectedMod:     []string{"modify.txt"},
			expectedUnch:    []string{"keep.txt"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diff := ComputeDiff(tt.oldEntries, tt.newEntries)

			// Sort all slices for comparison
			sort.Strings(diff.Orphaned)
			sort.Strings(diff.Created)
			sort.Strings(diff.Modified)
			sort.Strings(diff.Unchanged)
			sort.Strings(tt.expectedOrphan)
			sort.Strings(tt.expectedCreated)
			sort.Strings(tt.expectedMod)
			sort.Strings(tt.expectedUnch)

			if !sliceEqual(diff.Orphaned, tt.expectedOrphan) {
				t.Errorf("Orphaned mismatch: got %v, expected %v", diff.Orphaned, tt.expectedOrphan)
			}
			if !sliceEqual(diff.Created, tt.expectedCreated) {
				t.Errorf("Created mismatch: got %v, expected %v", diff.Created, tt.expectedCreated)
			}
			if !sliceEqual(diff.Modified, tt.expectedMod) {
				t.Errorf("Modified mismatch: got %v, expected %v", diff.Modified, tt.expectedMod)
			}
			if !sliceEqual(diff.Unchanged, tt.expectedUnch) {
				t.Errorf("Unchanged mismatch: got %v, expected %v", diff.Unchanged, tt.expectedUnch)
			}
		})
	}
}

// TestApplyDiff verifies that diffs are correctly applied to the filesystem
func TestApplyDiff(t *testing.T) {
	// Create source directory with new files
	sourceDir, err := os.MkdirTemp("", "manifest-source-*")
	if err != nil {
		t.Fatalf("Failed to create source dir: %v", err)
	}
	defer os.RemoveAll(sourceDir)

	// Create output directory with existing files
	outputDir, err := os.MkdirTemp("", "manifest-output-*")
	if err != nil {
		t.Fatalf("Failed to create output dir: %v", err)
	}
	defer os.RemoveAll(outputDir)

	// Set up source files (new render result)
	sourceFiles := map[string]string{
		"terragrunt.hcl": "updated HCL content",
		"src/index.mjs":  "console.log('Hello from Node.js');",
	}
	for relPath, content := range sourceFiles {
		fullPath := filepath.Join(sourceDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("Failed to create directory: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to write source file: %v", err)
		}
	}

	// Set up output files (existing from previous render)
	outputFiles := map[string]string{
		"terragrunt.hcl": "old HCL content",
		"src/app.py":     "print('Hello from Python')",
	}
	for relPath, content := range outputFiles {
		fullPath := filepath.Join(outputDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("Failed to create directory: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to write output file: %v", err)
		}
	}

	// Create diff (simulating Python to Node.js switch in sample runbook)
	diff := DiffResult{
		Orphaned: []string{"src/app.py"},
		Created:  []string{"src/index.mjs"},
		Modified: []string{"terragrunt.hcl"},
		// No unchanged files in this scenario
	}

	// Apply diff
	written, deleted, err := ApplyDiff(diff, sourceDir, outputDir)
	if err != nil {
		t.Fatalf("ApplyDiff failed: %v", err)
	}

	// Verify counts
	if written != 2 { // terragrunt.hcl + index.mjs
		t.Errorf("Expected 2 files written, got %d", written)
	}
	if deleted != 1 { // app.py
		t.Errorf("Expected 1 file deleted, got %d", deleted)
	}

	// Verify orphaned file was deleted
	if _, err := os.Stat(filepath.Join(outputDir, "src/app.py")); !os.IsNotExist(err) {
		t.Error("Orphaned file src/app.py should have been deleted")
	}

	// Verify created file exists with correct content
	content, err := os.ReadFile(filepath.Join(outputDir, "src/index.mjs"))
	if err != nil {
		t.Errorf("Failed to read created file: %v", err)
	} else if string(content) != sourceFiles["src/index.mjs"] {
		t.Errorf("Created file content mismatch")
	}

	// Verify modified file was updated
	content, err = os.ReadFile(filepath.Join(outputDir, "terragrunt.hcl"))
	if err != nil {
		t.Errorf("Failed to read modified file: %v", err)
	} else if string(content) != sourceFiles["terragrunt.hcl"] {
		t.Errorf("Modified file content mismatch")
	}
}

// TestFileManifestStore verifies the in-memory store operations
func TestFileManifestStore(t *testing.T) {
	store := NewFileManifestStore()

	// Test Get on empty store
	if manifest := store.Get("nonexistent"); manifest != nil {
		t.Error("Expected nil for nonexistent template")
	}

	// Test Set and Get
	manifest := &TemplateManifest{
		TemplateID: "test-template",
		OutputDir:  "/output",
		Files: []ManifestEntry{
			{Path: "file1.txt", ContentHash: "hash1"},
		},
	}
	store.Set("test-template", manifest)

	retrieved := store.Get("test-template")
	if retrieved == nil {
		t.Fatal("Expected to retrieve stored manifest")
	}
	if retrieved.TemplateID != "test-template" {
		t.Errorf("TemplateID mismatch: got %s", retrieved.TemplateID)
	}
	if len(retrieved.Files) != 1 {
		t.Errorf("Expected 1 file, got %d", len(retrieved.Files))
	}

	// Test Delete
	store.Delete("test-template")
	if manifest := store.Get("test-template"); manifest != nil {
		t.Error("Expected nil after delete")
	}

	// Test Clear
	store.Set("a", &TemplateManifest{TemplateID: "a"})
	store.Set("b", &TemplateManifest{TemplateID: "b"})
	store.Clear()
	if store.Get("a") != nil || store.Get("b") != nil {
		t.Error("Expected all manifests cleared")
	}
}

// TestRenderWithManifest tests the end-to-end render with manifest workflow
func TestRenderWithManifest(t *testing.T) {
	// Clear global store before test
	GetManifestStore().Clear()

	// Create output directory
	outputDir, err := os.MkdirTemp("", "manifest-render-output-*")
	if err != nil {
		t.Fatalf("Failed to create output dir: %v", err)
	}
	defer os.RemoveAll(outputDir)

	// First render: generate Python files
	pythonFiles := map[string]string{
		"terragrunt.hcl": "HCL v1",
		"src/app.py":     "Python code",
	}

	diff1, err := RenderWithManifest("lambda-template", func() (string, error) {
		tempDir, err := os.MkdirTemp("", "render-temp-*")
		if err != nil {
			return "", err
		}
		for relPath, content := range pythonFiles {
			fullPath := filepath.Join(tempDir, relPath)
			os.MkdirAll(filepath.Dir(fullPath), 0755)
			os.WriteFile(fullPath, []byte(content), 0644)
		}
		return tempDir, nil
	}, outputDir)

	if err != nil {
		t.Fatalf("First render failed: %v", err)
	}

	// Verify first render created files
	if len(diff1.Created) != 2 {
		t.Errorf("Expected 2 created files in first render, got %d", len(diff1.Created))
	}
	if len(diff1.Orphaned) != 0 {
		t.Errorf("Expected no orphaned files in first render, got %d", len(diff1.Orphaned))
	}

	// Verify files exist
	if _, err := os.Stat(filepath.Join(outputDir, "src/app.py")); os.IsNotExist(err) {
		t.Error("Python file should exist after first render")
	}

	// Second render: switch to Node.js
	nodejsFiles := map[string]string{
		"terragrunt.hcl": "HCL v2", // Modified
		"src/index.mjs":  "Node.js code",
	}

	diff2, err := RenderWithManifest("lambda-template", func() (string, error) {
		tempDir, err := os.MkdirTemp("", "render-temp-*")
		if err != nil {
			return "", err
		}
		for relPath, content := range nodejsFiles {
			fullPath := filepath.Join(tempDir, relPath)
			os.MkdirAll(filepath.Dir(fullPath), 0755)
			os.WriteFile(fullPath, []byte(content), 0644)
		}
		return tempDir, nil
	}, outputDir)

	if err != nil {
		t.Fatalf("Second render failed: %v", err)
	}

	// Verify second render diff
	if len(diff2.Orphaned) != 1 || diff2.Orphaned[0] != "src/app.py" {
		t.Errorf("Expected src/app.py to be orphaned, got %v", diff2.Orphaned)
	}
	if len(diff2.Created) != 1 || diff2.Created[0] != "src/index.mjs" {
		t.Errorf("Expected src/index.mjs to be created, got %v", diff2.Created)
	}
	if len(diff2.Modified) != 1 || diff2.Modified[0] != "terragrunt.hcl" {
		t.Errorf("Expected terragrunt.hcl to be modified, got %v", diff2.Modified)
	}

	// Verify filesystem state
	if _, err := os.Stat(filepath.Join(outputDir, "src/app.py")); !os.IsNotExist(err) {
		t.Error("Python file should have been deleted")
	}
	if _, err := os.Stat(filepath.Join(outputDir, "src/index.mjs")); os.IsNotExist(err) {
		t.Error("Node.js file should exist")
	}

	// Verify HCL was updated
	content, _ := os.ReadFile(filepath.Join(outputDir, "terragrunt.hcl"))
	if string(content) != "HCL v2" {
		t.Errorf("HCL file should have updated content, got: %s", string(content))
	}
}

// TestRenderWithManifest_SkipsUnchangedFiles verifies that unchanged files are not rewritten
func TestRenderWithManifest_SkipsUnchangedFiles(t *testing.T) {
	// Clear global store before test
	GetManifestStore().Clear()

	// Create output directory
	outputDir, err := os.MkdirTemp("", "manifest-unchanged-*")
	if err != nil {
		t.Fatalf("Failed to create output dir: %v", err)
	}
	defer os.RemoveAll(outputDir)

	files := map[string]string{
		"config.yml":     "same content",
		"terragrunt.hcl": "HCL content",
	}

	// First render
	_, err = RenderWithManifest("test-template", func() (string, error) {
		tempDir, _ := os.MkdirTemp("", "render-*")
		for relPath, content := range files {
			os.WriteFile(filepath.Join(tempDir, relPath), []byte(content), 0644)
		}
		return tempDir, nil
	}, outputDir)
	if err != nil {
		t.Fatalf("First render failed: %v", err)
	}

	// Second render with same files
	diff2, err := RenderWithManifest("test-template", func() (string, error) {
		tempDir, _ := os.MkdirTemp("", "render-*")
		for relPath, content := range files {
			os.WriteFile(filepath.Join(tempDir, relPath), []byte(content), 0644)
		}
		return tempDir, nil
	}, outputDir)
	if err != nil {
		t.Fatalf("Second render failed: %v", err)
	}

	// Verify all files are marked as unchanged
	if len(diff2.Unchanged) != 2 {
		t.Errorf("Expected 2 unchanged files, got %d", len(diff2.Unchanged))
	}
	if len(diff2.Created) != 0 || len(diff2.Modified) != 0 || len(diff2.Orphaned) != 0 {
		t.Errorf("Expected no changes, got: created=%v, modified=%v, orphaned=%v",
			diff2.Created, diff2.Modified, diff2.Orphaned)
	}
}

// TestCleanupEmptyParentDirs verifies that empty parent directories are cleaned up
func TestCleanupEmptyParentDirs(t *testing.T) {
	// Create output directory
	outputDir, err := os.MkdirTemp("", "cleanup-test-*")
	if err != nil {
		t.Fatalf("Failed to create output dir: %v", err)
	}
	defer os.RemoveAll(outputDir)

	// Create nested structure
	nestedPath := filepath.Join(outputDir, "a", "b", "c", "file.txt")
	os.MkdirAll(filepath.Dir(nestedPath), 0755)
	os.WriteFile(nestedPath, []byte("content"), 0644)

	// Delete the file
	os.Remove(nestedPath)

	// Clean up empty parents
	cleanupEmptyParentDirs(filepath.Dir(nestedPath), outputDir)

	// Verify directories were removed
	if _, err := os.Stat(filepath.Join(outputDir, "a")); !os.IsNotExist(err) {
		t.Error("Empty directory 'a' should have been removed")
	}
}

// sliceEqual compares two string slices for equality
func sliceEqual(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestApplyDiff_RejectsUnsafePaths verifies that ApplyDiff refuses to operate on unsafe paths
func TestApplyDiff_RejectsUnsafePaths(t *testing.T) {
	// Create directories
	sourceDir, _ := os.MkdirTemp("", "source-*")
	outputDir, _ := os.MkdirTemp("", "output-*")
	defer os.RemoveAll(sourceDir)
	defer os.RemoveAll(outputDir)

	// Create a file in source that we'd try to copy
	os.WriteFile(filepath.Join(sourceDir, "legit.txt"), []byte("content"), 0644)

	tests := []struct {
		name     string
		diff     DiffResult
		wantErr  bool
		errField string // which field should cause the error
	}{
		{
			name: "traversal in orphaned",
			diff: DiffResult{
				Orphaned: []string{"../../../etc/passwd"},
			},
			wantErr:  true,
			errField: "orphaned",
		},
		{
			name: "traversal in created",
			diff: DiffResult{
				Created: []string{"../../../tmp/evil.txt"},
			},
			wantErr:  true,
			errField: "created",
		},
		{
			name: "traversal in modified",
			diff: DiffResult{
				Modified: []string{"src/../../escape.txt"},
			},
			wantErr:  true,
			errField: "modified",
		},
		{
			name: "absolute path in orphaned",
			diff: DiffResult{
				Orphaned: []string{"/etc/passwd"},
			},
			wantErr:  true,
			errField: "orphaned",
		},
		{
			name: "safe paths work",
			diff: DiffResult{
				Created: []string{"legit.txt"},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := ApplyDiff(tt.diff, sourceDir, outputDir)

			if tt.wantErr && err == nil {
				t.Errorf("Expected error for unsafe %s path, but got none", tt.errField)
			}

			if !tt.wantErr && err != nil {
				t.Errorf("Expected success but got error: %v", err)
			}

			if tt.wantErr && err != nil {
				t.Logf("OK: Rejected unsafe path in %s: %v", tt.errField, err)
			}
		})
	}
}

// TestApplyDiff_NeverDeletesOutsideOutputDir is a defense-in-depth test
// that verifies files outside outputDir are never touched even if somehow
// a malicious path got into the manifest
func TestApplyDiff_NeverDeletesOutsideOutputDir(t *testing.T) {
	// Create a "victim" file outside the output directory
	victimDir, _ := os.MkdirTemp("", "victim-*")
	defer os.RemoveAll(victimDir)

	victimFile := filepath.Join(victimDir, "precious.txt")
	os.WriteFile(victimFile, []byte("do not delete me!"), 0644)

	// Create output directory
	outputDir, _ := os.MkdirTemp("", "output-*")
	defer os.RemoveAll(outputDir)

	// Create source directory
	sourceDir, _ := os.MkdirTemp("", "source-*")
	defer os.RemoveAll(sourceDir)

	// Try various attack vectors
	attackPaths := []string{
		"../victim-dir/precious.txt",                   // Simple traversal
		"src/../../victim-dir/precious.txt",            // Hidden traversal
		filepath.Join("..", filepath.Base(victimDir), "precious.txt"), // Dynamic traversal
	}

	for _, attackPath := range attackPaths {
		t.Run(attackPath, func(t *testing.T) {
			diff := DiffResult{
				Orphaned: []string{attackPath},
			}

			_, _, err := ApplyDiff(diff, sourceDir, outputDir)

			// Should error due to path validation
			if err == nil {
				t.Errorf("Expected error for attack path %q", attackPath)
			}

			// Verify victim file still exists
			if _, statErr := os.Stat(victimFile); os.IsNotExist(statErr) {
				t.Fatalf("CRITICAL: Victim file was deleted by attack path %q!", attackPath)
			}
		})
	}

	// Final verification
	content, _ := os.ReadFile(victimFile)
	if string(content) != "do not delete me!" {
		t.Fatal("CRITICAL: Victim file content was modified!")
	}

	t.Log("OK: All attack vectors blocked, victim file intact")
}

