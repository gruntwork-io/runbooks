package api

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildFileTreeWithContentBasic(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0755); err != nil {
		t.Fatalf("failed to create src dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello\n"), 0644); err != nil {
		t.Fatalf("failed to write README.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatalf("failed to write main.go: %v", err)
	}

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	if result.TotalFiles != 2 {
		t.Errorf("expected 2 total files, got %d", result.TotalFiles)
	}
	if result.TruncatedTree {
		t.Error("expected TruncatedTree=false for small directory")
	}

	// Verify file content is included
	for _, node := range result.Tree {
		if node.Type == "file" && node.File != nil {
			if node.File.Content == "" {
				t.Errorf("expected non-empty content for %s", node.Name)
			}
		}
	}
}

func TestBuildFileTreeWithContentTruncatesWhenTooManyFiles(t *testing.T) {
	orig := maxFileTreeFiles
	maxFileTreeFiles = 5
	t.Cleanup(func() { maxFileTreeFiles = orig })

	dir := t.TempDir()
	for i := 0; i < maxFileTreeFiles+3; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("file_%d.txt", i)), []byte("x"), 0644)
	}

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	if !result.TruncatedTree {
		t.Error("expected TruncatedTree=true when file count exceeds limit")
	}
	if result.TotalFiles != maxFileTreeFiles+3 {
		t.Errorf("expected totalFiles=%d, got %d", maxFileTreeFiles+3, result.TotalFiles)
	}

	// Count files in tree (should be capped at the limit)
	fileCount := 0
	var countFiles func(nodes []FileTreeNode)
	countFiles = func(nodes []FileTreeNode) {
		for _, n := range nodes {
			if n.Type == "file" {
				fileCount++
			}
			if n.Children != nil {
				countFiles(n.Children)
			}
		}
	}
	countFiles(result.Tree)

	if fileCount > maxFileTreeFiles {
		t.Errorf("expected at most %d files in tree, got %d", maxFileTreeFiles, fileCount)
	}
}

func TestBuildFileTreeWithContentDoesNotFilterGitignored(t *testing.T) {
	dir := t.TempDir()

	// Even with a .gitignore present, the generated files tree should
	// include all files — the output directory is not a git repo.
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules/\n*.pyc\n"), 0644)
	os.MkdirAll(filepath.Join(dir, "node_modules", "express"), 0755)
	os.WriteFile(filepath.Join(dir, "node_modules", "express", "index.js"), []byte("module.exports = {};\n"), 0644)
	os.WriteFile(filepath.Join(dir, "index.js"), []byte("const app = require('express')();\n"), 0644)
	os.WriteFile(filepath.Join(dir, "app.pyc"), []byte("bytecode"), 0644)

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	// All 4 files should be counted: .gitignore, index.js, app.pyc, node_modules/express/index.js
	if result.TotalFiles != 4 {
		t.Errorf("expected 4 files (gitignore rules should not filter), got %d", result.TotalFiles)
	}

	foundNodeModules := false
	foundPyc := false
	for _, node := range result.Tree {
		if node.Name == "node_modules" {
			foundNodeModules = true
		}
		if node.Name == "app.pyc" {
			foundPyc = true
		}
	}
	if !foundNodeModules {
		t.Error("node_modules should be included — output directory is not a git repo")
	}
	if !foundPyc {
		t.Error("app.pyc should be included — output directory is not a git repo")
	}
}

func TestBuildFileTreeWithContentDetectsHeavyDir(t *testing.T) {
	orig := maxFileTreeFiles
	maxFileTreeFiles = 5
	t.Cleanup(func() { maxFileTreeFiles = orig })

	dir := t.TempDir()

	// Create a heavy directory that exceeds the file limit
	os.MkdirAll(filepath.Join(dir, "vendor", "lib"), 0755)
	for i := 0; i < maxFileTreeFiles+3; i++ {
		os.WriteFile(filepath.Join(dir, "vendor", "lib", fmt.Sprintf("dep_%d.go", i)), []byte("package lib\n"), 0644)
	}
	// One file at root level
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0644)

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	if !result.TruncatedTree {
		t.Error("expected TruncatedTree=true")
	}
	if result.HeavyDir != "vendor" {
		t.Errorf("expected HeavyDir='vendor', got %q", result.HeavyDir)
	}
	if result.HeavyDirFileCount != maxFileTreeFiles+3 {
		t.Errorf("expected HeavyDirFileCount=%d, got %d", maxFileTreeFiles+3, result.HeavyDirFileCount)
	}
}

func TestBuildFileTreeWithContentTruncatesLargeFiles(t *testing.T) {
	orig := maxFileTreeFileSize
	maxFileTreeFileSize = 64
	t.Cleanup(func() { maxFileTreeFileSize = orig })

	dir := t.TempDir()
	largeContent := make([]byte, int(maxFileTreeFileSize)+1)
	for i := range largeContent {
		largeContent[i] = 'x'
	}
	os.WriteFile(filepath.Join(dir, "large.txt"), largeContent, 0644)
	os.WriteFile(filepath.Join(dir, "small.txt"), []byte("small\n"), 0644)

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	for _, node := range result.Tree {
		if node.File == nil {
			continue
		}
		if node.Name == "large.txt" {
			if !node.File.IsTruncated {
				t.Error("expected IsTruncated=true for large file")
			}
			if node.File.Content != "" {
				t.Error("expected empty content for truncated file")
			}
		}
		if node.Name == "small.txt" {
			if node.File.IsTruncated {
				t.Error("expected IsTruncated=false for small file")
			}
			if node.File.Content != "small\n" {
				t.Errorf("expected content 'small\\n', got %q", node.File.Content)
			}
		}
	}
}

func TestBuildFileTreeWithContentAlwaysSkipsVCSDirs(t *testing.T) {
	dir := t.TempDir()

	// VCS directories should always be skipped (no gitignore needed)
	os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0755)
	os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0644)
	os.MkdirAll(filepath.Join(dir, ".svn"), 0755)
	os.WriteFile(filepath.Join(dir, ".svn", "entries"), []byte("svn data\n"), 0644)
	os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log('hi')\n"), 0644)

	result, err := buildFileTreeWithContentResult(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithContentResult failed: %v", err)
	}

	if result.TotalFiles != 1 {
		t.Errorf("expected 1 file (VCS dirs always skipped), got %d", result.TotalFiles)
	}

	for _, node := range result.Tree {
		if node.Name == ".git" || node.Name == ".svn" {
			t.Errorf("VCS directory %s should be excluded from file tree", node.Name)
		}
	}
}
