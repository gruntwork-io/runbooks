package watcher_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/core/watcher"
)

// seed writes a tree of relative path → content into root and returns
// root. Directories are created implicitly from the path components.
func seed(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
	return root
}

func TestWalkHashesAllRegularFiles(t *testing.T) {
	root := seed(t, map[string]string{
		"gruntbook.mdx":        "# hello",
		"scripts/deploy.sh":    "#!/bin/bash\necho hi\n",
		"templates/main.tf":    "resource \"null\" \"x\" {}\n",
		"checks/precheck.sh":   "exit 0",
		"nested/sub/inner.txt": "nested",
	})

	snap, err := watcher.Walk(adapters.NewOsFileSystem(), root, "")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}

	want := []string{
		"gruntbook.mdx",
		"scripts/deploy.sh",
		"templates/main.tf",
		"checks/precheck.sh",
		"nested/sub/inner.txt",
	}
	if len(snap) != len(want) {
		t.Fatalf("snap has %d entries, want %d: %v", len(snap), len(want), snap)
	}
	for _, p := range want {
		if _, ok := snap[p]; !ok {
			t.Errorf("snap missing %q", p)
		}
	}
}

func TestWalkSkipsExcludedDirs(t *testing.T) {
	root := seed(t, map[string]string{
		"gruntbook.mdx":              "# hi",
		".git/HEAD":                  "ref: refs/heads/main",
		".git/objects/abc/def":       "blob",
		"node_modules/foo/index.js":  "module.exports = {}",
		"node_modules/bar/README.md": "docs",
	})

	snap, err := watcher.Walk(adapters.NewOsFileSystem(), root, "")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}

	for p := range snap {
		if p == ".git" || p == "node_modules" ||
			filepath.HasPrefix(p, ".git/") ||
			filepath.HasPrefix(p, "node_modules/") {
			t.Errorf("snap should not contain excluded path %q", p)
		}
	}
	if _, ok := snap["gruntbook.mdx"]; !ok {
		t.Errorf("snap missing gruntbook.mdx")
	}
}

func TestWalkSkipsOutputPath(t *testing.T) {
	root := seed(t, map[string]string{
		"gruntbook.mdx":           "# hi",
		"generated/artifact.txt":  "output",
		"generated/nested/a.json": "{}",
		"scripts/deploy.sh":       "#!/bin/bash",
	})

	snap, err := watcher.Walk(adapters.NewOsFileSystem(), root, "generated")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}

	for p := range snap {
		if p == "generated" || len(p) > len("generated/") && p[:len("generated/")] == "generated/" {
			t.Errorf("snap should not contain output path %q", p)
		}
	}
	if _, ok := snap["scripts/deploy.sh"]; !ok {
		t.Errorf("snap missing scripts/deploy.sh")
	}
}

func TestWalkEmitsSamePathOnAllOSes(t *testing.T) {
	root := seed(t, map[string]string{
		"a/b/c.txt": "hi",
	})

	snap, err := watcher.Walk(adapters.NewOsFileSystem(), root, "")
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if _, ok := snap["a/b/c.txt"]; !ok {
		t.Errorf("expected forward-slash path 'a/b/c.txt' in snapshot, got %v", snap)
	}
}

func TestWalkContentIdenticalWritesProduceSameHash(t *testing.T) {
	root := seed(t, map[string]string{"gruntbook.mdx": "# hello"})

	fsys := adapters.NewOsFileSystem()
	snap1, err := watcher.Walk(fsys, root, "")
	if err != nil {
		t.Fatalf("Walk 1: %v", err)
	}
	// Re-write the same content — editor "touch" without change.
	if err := os.WriteFile(filepath.Join(root, "gruntbook.mdx"), []byte("# hello"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	snap2, err := watcher.Walk(fsys, root, "")
	if err != nil {
		t.Fatalf("Walk 2: %v", err)
	}
	if snap1["gruntbook.mdx"] != snap2["gruntbook.mdx"] {
		t.Errorf("content-identical write produced different hashes: %s vs %s",
			snap1["gruntbook.mdx"], snap2["gruntbook.mdx"])
	}
}
