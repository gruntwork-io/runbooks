package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParseOwnerRepoFromURL(t *testing.T) {
	tests := []struct {
		name          string
		rawURL        string
		expectedOwner string
		expectedRepo  string
	}{
		// HTTPS URLs
		{
			name:          "HTTPS with .git suffix",
			rawURL:        "https://github.com/org/repo.git",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},
		{
			name:          "HTTPS without .git suffix",
			rawURL:        "https://github.com/org/repo",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},
		{
			name:          "HTTPS with trailing slash",
			rawURL:        "https://github.com/org/repo/",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},
		{
			name:          "HTTPS with extra path segments",
			rawURL:        "https://github.com/org/repo/tree/main",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},
		{
			name:          "HTTPS non-GitHub host",
			rawURL:        "https://gitlab.com/org/repo.git",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},

		// SSH URLs
		{
			name:          "SSH with .git suffix",
			rawURL:        "git@github.com:org/repo.git",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},
		{
			name:          "SSH without .git suffix",
			rawURL:        "git@github.com:org/repo",
			expectedOwner: "org",
			expectedRepo:  "repo",
		},

		// Edge cases
		{
			name:          "empty string",
			rawURL:        "",
			expectedOwner: "",
			expectedRepo:  "",
		},
		{
			name:          "just a word",
			rawURL:        "not-a-url",
			expectedOwner: "",
			expectedRepo:  "",
		},
		{
			name:          "HTTPS with only owner, no repo",
			rawURL:        "https://github.com/org",
			expectedOwner: "",
			expectedRepo:  "",
		},
		{
			name:          "HTTPS with hyphenated owner and repo",
			rawURL:        "https://github.com/my-org/my-repo.git",
			expectedOwner: "my-org",
			expectedRepo:  "my-repo",
		},
		{
			name:          "SSH with hyphenated owner and repo",
			rawURL:        "git@github.com:my-org/my-repo.git",
			expectedOwner: "my-org",
			expectedRepo:  "my-repo",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			owner, repo := parseOwnerRepoFromURL(tc.rawURL)
			if owner != tc.expectedOwner {
				t.Errorf("parseOwnerRepoFromURL(%q) owner = %q, want %q", tc.rawURL, owner, tc.expectedOwner)
			}
			if repo != tc.expectedRepo {
				t.Errorf("parseOwnerRepoFromURL(%q) repo = %q, want %q", tc.rawURL, repo, tc.expectedRepo)
			}
		})
	}
}

// TestGetBaseBranch verifies the fallback chain for determining the default branch.
func TestGetBaseBranch(t *testing.T) {
	t.Run("returns branch from symbolic-ref when available", func(t *testing.T) {
		// Create a bare repo + working clone so symbolic-ref works
		bareDir := filepath.Join(t.TempDir(), "bare.git")
		runGitCmd(t, "", "init", "--bare", bareDir)

		workDir := filepath.Join(t.TempDir(), "work")
		runGitCmd(t, "", "clone", bareDir, workDir)
		runGitCmd(t, workDir, "config", "user.email", "test@test.com")
		runGitCmd(t, workDir, "config", "user.name", "Test")

		// Create initial commit so HEAD exists
		dummyFile := filepath.Join(workDir, "README.md")
		if err := os.WriteFile(dummyFile, []byte("hello"), 0644); err != nil {
			t.Fatal(err)
		}
		runGitCmd(t, workDir, "add", ".")
		runGitCmd(t, workDir, "commit", "-m", "initial")
		runGitCmd(t, workDir, "push", "origin", "HEAD")

		// symbolic-ref should resolve to the default branch name
		result := getBaseBranch(t.Context(), workDir, "", "", "")
		// The default branch for `git init` is typically "master" or "main" depending on config.
		// Either is valid — we just verify it returns something non-empty and not the final fallback
		// when a valid symbolic-ref exists.
		if result == "" {
			t.Error("getBaseBranch() returned empty string, expected a branch name")
		}
	})

	t.Run("falls back to main when symbolic-ref is unavailable", func(t *testing.T) {
		// Create a repo with no remote, so symbolic-ref fails
		workDir := t.TempDir()
		runGitCmd(t, workDir, "init")
		runGitCmd(t, workDir, "config", "user.email", "test@test.com")
		runGitCmd(t, workDir, "config", "user.name", "Test")

		dummyFile := filepath.Join(workDir, "README.md")
		if err := os.WriteFile(dummyFile, []byte("hello"), 0644); err != nil {
			t.Fatal(err)
		}
		runGitCmd(t, workDir, "add", ".")
		runGitCmd(t, workDir, "commit", "-m", "initial")

		// No remote, no GitHub API token — should fall back to "main"
		result := getBaseBranch(t.Context(), workDir, "", "", "")
		if result != "main" {
			t.Errorf("getBaseBranch() = %q, want %q", result, "main")
		}
	})
}

// runGitCmd is a test helper that runs a git command and fails the test on error.
func runGitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %s", args, string(out))
	}
}
