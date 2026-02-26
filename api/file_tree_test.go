package api

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildFileTreeBasic(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src"), 0755)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello\n"), 0644)
	os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main\n"), 0644)

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
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

func TestBuildFileTreeTruncatesWhenTooManyFiles(t *testing.T) {
	orig := maxFileTreeFiles
	maxFileTreeFiles = 5
	t.Cleanup(func() { maxFileTreeFiles = orig })

	dir := t.TempDir()
	for i := 0; i < maxFileTreeFiles+3; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("file_%d.txt", i)), []byte("x"), 0644)
	}

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
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

func TestBuildFileTreeRespectsGitignore(t *testing.T) {
	dir := t.TempDir()

	// Create a .gitignore that excludes node_modules
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules/\n"), 0644)

	// Create node_modules with files
	os.MkdirAll(filepath.Join(dir, "node_modules", "express"), 0755)
	os.WriteFile(filepath.Join(dir, "node_modules", "express", "index.js"), []byte("module.exports = {};\n"), 0644)

	// Create a normal file
	os.WriteFile(filepath.Join(dir, "index.js"), []byte("const app = require('express')();\n"), 0644)

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
	}

	// Should contain index.js and .gitignore, but not node_modules
	if result.TotalFiles != 2 {
		t.Errorf("expected 2 files (.gitignore + index.js, node_modules should be skipped), got %d", result.TotalFiles)
	}

	// Verify node_modules is not in the tree
	for _, node := range result.Tree {
		if node.Name == "node_modules" {
			t.Error("node_modules should be excluded from file tree when in .gitignore")
		}
	}
}

func TestBuildFileTreeWithoutGitignoreIncludesAllDirs(t *testing.T) {
	dir := t.TempDir()

	// No .gitignore — node_modules should be included
	os.MkdirAll(filepath.Join(dir, "node_modules", "express"), 0755)
	os.WriteFile(filepath.Join(dir, "node_modules", "express", "index.js"), []byte("module.exports = {};\n"), 0644)
	os.WriteFile(filepath.Join(dir, "index.js"), []byte("const app = require('express')();\n"), 0644)

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
	}

	// Both files should be counted
	if result.TotalFiles != 2 {
		t.Errorf("expected 2 files (no .gitignore, all dirs included), got %d", result.TotalFiles)
	}

	// Verify node_modules IS in the tree
	foundNodeModules := false
	for _, node := range result.Tree {
		if node.Name == "node_modules" {
			foundNodeModules = true
		}
	}
	if !foundNodeModules {
		t.Error("node_modules should be included when there is no .gitignore")
	}
}

func TestBuildFileTreeGitignoreGlobPattern(t *testing.T) {
	dir := t.TempDir()

	// Gitignore with glob pattern
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*.pyc\n__pycache__/\n"), 0644)
	os.MkdirAll(filepath.Join(dir, "__pycache__"), 0755)
	os.WriteFile(filepath.Join(dir, "__pycache__", "module.cpython-311.pyc"), []byte("bytecode"), 0644)
	os.WriteFile(filepath.Join(dir, "app.py"), []byte("print('hello')\n"), 0644)
	os.WriteFile(filepath.Join(dir, "app.pyc"), []byte("bytecode"), 0644)

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
	}

	// Should contain .gitignore and app.py only
	if result.TotalFiles != 2 {
		t.Errorf("expected 2 files (.gitignore + app.py), got %d", result.TotalFiles)
	}

	for _, node := range result.Tree {
		if node.Name == "__pycache__" {
			t.Error("__pycache__ should be excluded via .gitignore")
		}
		if node.Name == "app.pyc" {
			t.Error("*.pyc files should be excluded via .gitignore glob pattern")
		}
	}
}

func TestBuildFileTreeDetectsHeavyDir(t *testing.T) {
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

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
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

func TestBuildFileTreeTruncatesLargeFiles(t *testing.T) {
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

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
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

func TestBuildFileTreeAlwaysSkipsVCSDirs(t *testing.T) {
	dir := t.TempDir()

	// VCS directories should always be skipped (no gitignore needed)
	os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0755)
	os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0644)
	os.MkdirAll(filepath.Join(dir, ".svn"), 0755)
	os.WriteFile(filepath.Join(dir, ".svn", "entries"), []byte("svn data\n"), 0644)
	os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log('hi')\n"), 0644)

	result, err := buildFileTreeWithRoot(dir, "")
	if err != nil {
		t.Fatalf("buildFileTreeWithRoot failed: %v", err)
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
