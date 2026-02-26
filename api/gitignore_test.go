package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadGitignoreReturnsNilWhenMissing(t *testing.T) {
	dir := t.TempDir()
	rules := loadGitignore(dir)
	if rules != nil {
		t.Error("expected nil when .gitignore does not exist")
	}
}

func TestLoadGitignoreReturnsNilWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("# just a comment\n\n"), 0644)
	rules := loadGitignore(dir)
	if rules != nil {
		t.Error("expected nil when .gitignore has only comments and blank lines")
	}
}

func TestGitignoreMatchesExactName(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules\n"), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	if !rules.isIgnored("node_modules", true, "") {
		t.Error("expected node_modules directory to be ignored")
	}
	if !rules.isIgnored("node_modules", false, "") {
		t.Error("expected node_modules file to be ignored (pattern without trailing /)")
	}
	if rules.isIgnored("src", true, "") {
		t.Error("src should not be ignored")
	}
}

func TestGitignoreDirOnlyPattern(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("build/\n"), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	if !rules.isIgnored("build", true, "") {
		t.Error("expected build directory to be ignored")
	}
	if rules.isIgnored("build", false, "") {
		t.Error("build file should NOT be ignored by dir-only pattern")
	}
}

func TestGitignoreGlobPattern(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*.pyc\n*.log\n"), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	if !rules.isIgnored("module.pyc", false, "") {
		t.Error("expected .pyc file to be ignored")
	}
	if !rules.isIgnored("server.log", false, "logs") {
		t.Error("expected .log file to be ignored")
	}
	if rules.isIgnored("module.py", false, "") {
		t.Error("expected .py file to NOT be ignored")
	}
}

func TestGitignoreNegation(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*.log\n!important.log\n"), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	if !rules.isIgnored("debug.log", false, "") {
		t.Error("expected debug.log to be ignored")
	}
	if rules.isIgnored("important.log", false, "") {
		t.Error("expected important.log to NOT be ignored (negated)")
	}
}

func TestGitignoreRootedPattern(t *testing.T) {
	dir := t.TempDir()
	// /build only matches "build" at the root, not nested "build" dirs
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("/build\n"), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	// At root: name="build", relativePath="" → entry path would be "build"
	if !rules.isIgnored("build", true, "") {
		t.Error("expected root-level build to be ignored")
	}

	// Nested: name="build", relativePath="src" → entry path would be "src/build"
	if rules.isIgnored("build", true, "src") {
		t.Error("expected nested build to NOT be ignored (rooted pattern)")
	}
}

func TestGitignoreNilSafe(t *testing.T) {
	var rules *gitignoreRules
	// Should not panic when called on nil
	if rules.isIgnored("anything", true, "") {
		t.Error("nil rules should never report ignored")
	}
}

func TestGitignoreMultiplePatterns(t *testing.T) {
	dir := t.TempDir()
	content := `# Dependencies
node_modules/
.venv/

# Build artifacts
dist/
*.pyc

# IDE
.idea/
`
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(content), 0644)
	rules := loadGitignore(dir)
	if rules == nil {
		t.Fatal("expected non-nil rules")
	}

	tests := []struct {
		name    string
		isDir   bool
		relPath string
		ignored bool
	}{
		{"node_modules", true, "", true},
		{".venv", true, "", true},
		{"dist", true, "", true},
		{".idea", true, "", true},
		{"module.pyc", false, "", true},
		{"src", true, "", false},
		{"main.py", false, "", false},
		{"README.md", false, "", false},
	}

	for _, tt := range tests {
		got := rules.isIgnored(tt.name, tt.isDir, tt.relPath)
		if got != tt.ignored {
			t.Errorf("isIgnored(%q, isDir=%v, relPath=%q) = %v, want %v", tt.name, tt.isDir, tt.relPath, got, tt.ignored)
		}
	}
}
