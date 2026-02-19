package api

import (
	"testing"
)

func TestInjectGitToken(t *testing.T) {
	tests := []struct {
		name     string
		rawURL   string
		token    string
		expected string
	}{
		{
			name:     "HTTPS URL gets token injected",
			rawURL:   "https://github.com/org/repo.git",
			token:    "ghp_abc123",
			expected: "https://x-access-token:ghp_abc123@github.com/org/repo.git",
		},
		{
			name:     "HTTPS URL without .git suffix",
			rawURL:   "https://github.com/org/repo",
			token:    "ghp_abc123",
			expected: "https://x-access-token:ghp_abc123@github.com/org/repo",
		},
		{
			name:     "SSH URL is returned unchanged",
			rawURL:   "git@github.com:org/repo.git",
			token:    "ghp_abc123",
			expected: "git@github.com:org/repo.git",
		},
		{
			name:     "HTTP URL is returned unchanged (not HTTPS)",
			rawURL:   "http://github.com/org/repo.git",
			token:    "ghp_abc123",
			expected: "http://github.com/org/repo.git",
		},
		{
			name:     "empty URL returned unchanged",
			rawURL:   "",
			token:    "ghp_abc123",
			expected: "",
		},
		{
			name:     "empty token returns URL unchanged",
			rawURL:   "https://github.com/org/repo.git",
			token:    "",
			expected: "https://github.com/org/repo.git",
		},
		{
			name:     "URL with existing user info gets overwritten",
			rawURL:   "https://olduser:oldpass@github.com/org/repo.git",
			token:    "ghp_new",
			expected: "https://x-access-token:ghp_new@github.com/org/repo.git",
		},
		{
			name:     "GitLab URL uses oauth2 username",
			rawURL:   "https://gitlab.com/org/repo.git",
			token:    "glpat_abc123",
			expected: "https://oauth2:glpat_abc123@gitlab.com/org/repo.git",
		},
		{
			name:     "GitLab URL without .git suffix",
			rawURL:   "https://gitlab.com/org/repo",
			token:    "glpat_abc123",
			expected: "https://oauth2:glpat_abc123@gitlab.com/org/repo",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := InjectGitToken(tc.rawURL, tc.token)
			if result != tc.expected {
				t.Errorf("InjectGitToken(%q, %q) = %q, want %q", tc.rawURL, tc.token, result, tc.expected)
			}
		})
	}
}

func TestSanitizeGitError(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "removes token from error message",
			input:    "fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/org/repo.git/': The requested URL returned error: 403",
			expected: "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 403",
		},
		{
			name:     "message without token is unchanged",
			input:    "fatal: not a git repository",
			expected: "fatal: not a git repository",
		},
		{
			name:     "empty message",
			input:    "",
			expected: "",
		},
		{
			name:     "removes multiple tokens in one message",
			input:    "x-access-token:abc@github.com and x-access-token:def@gitlab.com",
			expected: "github.com and gitlab.com",
		},
		{
			name:     "removes oauth2 token from GitLab URL",
			input:    "fatal: unable to access 'https://oauth2:glpat_secret@gitlab.com/org/repo.git/': The requested URL returned error: 403",
			expected: "fatal: unable to access 'https://gitlab.com/org/repo.git/': The requested URL returned error: 403",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := SanitizeGitError(tc.input)
			if result != tc.expected {
				t.Errorf("SanitizeGitError(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestIsValidGitHubOwner(t *testing.T) {
	tests := []struct {
		name     string
		owner    string
		expected bool
	}{
		// Valid owners
		{"simple name", "octocat", true},
		{"with hyphens", "my-org", true},
		{"single char", "a", true},
		{"alphanumeric", "org123", true},
		{"starts with number", "1org", true},

		// Invalid owners
		{"empty string", "", false},
		{"starts with hyphen", "-org", false},
		{"ends with hyphen", "org-", false},
		{"contains space", "my org", false},
		{"contains dot", "my.org", false},
		{"contains underscore", "my_org", false},
		{"too long (40 chars)", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false},
		{"exactly 39 chars is valid", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidGitHubOwner(tc.owner)
			if result != tc.expected {
				t.Errorf("isValidGitHubOwner(%q) = %v, want %v", tc.owner, result, tc.expected)
			}
		})
	}
}

func TestIsValidGitHubRepoName(t *testing.T) {
	tests := []struct {
		name     string
		repoName string
		expected bool
	}{
		// Valid repo names
		{"simple name", "my-repo", true},
		{"with dots", "repo.js", true},
		{"with underscores", "my_repo", true},
		{"alphanumeric only", "repo123", true},
		{"single char", "r", true},
		{"all allowed chars", "My-Repo_v2.0", true},

		// Invalid repo names
		{"empty string", "", false},
		{"contains space", "my repo", false},
		{"contains slash", "org/repo", false},
		{"contains at sign", "repo@v2", false},
		{"too long (101 chars)", string(make([]byte, 101)), false},
	}

	// Fix the "too long" test case — make([]byte, 101) gives null bytes, use a proper string
	tests[len(tests)-1].repoName = func() string {
		b := make([]byte, 101)
		for i := range b {
			b[i] = 'a'
		}
		return string(b)
	}()

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidGitHubRepoName(tc.repoName)
			if result != tc.expected {
				t.Errorf("isValidGitHubRepoName(%q) = %v, want %v", tc.repoName, result, tc.expected)
			}
		})
	}
}
