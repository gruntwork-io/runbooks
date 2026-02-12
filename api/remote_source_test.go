package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// =============================================================================
// ParseRemoteSource tests
// =============================================================================

func TestParseRemoteSource_GitHubBrowserURL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected *ParsedRemoteSource
	}{
		{
			name:  "tree URL with path",
			input: "https://github.com/gruntwork-io/runbooks/tree/main/runbooks/setup-vpc",
			expected: &ParsedRemoteSource{
				Host:          "github.com",
				Owner:         "gruntwork-io",
				Repo:          "runbooks",
				CloneURL:      "https://github.com/gruntwork-io/runbooks.git",
				rawRefAndPath: "main/runbooks/setup-vpc",
			},
		},
		{
			name:  "blob URL with runbook.mdx",
			input: "https://github.com/gruntwork-io/runbooks/blob/main/runbooks/setup-vpc/runbook.mdx",
			expected: &ParsedRemoteSource{
				Host:          "github.com",
				Owner:         "gruntwork-io",
				Repo:          "runbooks",
				CloneURL:      "https://github.com/gruntwork-io/runbooks.git",
				rawRefAndPath: "main/runbooks/setup-vpc/runbook.mdx",
			},
		},
		{
			name:  "plain repo URL",
			input: "https://github.com/gruntwork-io/runbooks",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "repo URL with trailing slash",
			input: "https://github.com/gruntwork-io/runbooks/",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "repo URL with .git suffix",
			input: "https://github.com/gruntwork-io/runbooks.git",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "tree URL with trailing slash",
			input: "https://github.com/org/repo/tree/main/path/to/runbook/",
			expected: &ParsedRemoteSource{
				Host:          "github.com",
				Owner:         "org",
				Repo:          "repo",
				CloneURL:      "https://github.com/org/repo.git",
				rawRefAndPath: "main/path/to/runbook",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			require.NoError(t, err)
			require.NotNil(t, result)
			assert.Equal(t, tt.expected.Host, result.Host)
			assert.Equal(t, tt.expected.Owner, result.Owner)
			assert.Equal(t, tt.expected.Repo, result.Repo)
			assert.Equal(t, tt.expected.Ref, result.Ref)
			assert.Equal(t, tt.expected.Path, result.Path)
			assert.Equal(t, tt.expected.CloneURL, result.CloneURL)
			assert.Equal(t, tt.expected.rawRefAndPath, result.rawRefAndPath)
		})
	}
}

func TestParseRemoteSource_GitLabBrowserURL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected *ParsedRemoteSource
	}{
		{
			name:  "tree URL with path",
			input: "https://gitlab.com/myorg/myrepo/-/tree/main/runbooks/setup-vpc",
			expected: &ParsedRemoteSource{
				Host:          "gitlab.com",
				Owner:         "myorg",
				Repo:          "myrepo",
				CloneURL:      "https://gitlab.com/myorg/myrepo.git",
				rawRefAndPath: "main/runbooks/setup-vpc",
			},
		},
		{
			name:  "blob URL with runbook.mdx",
			input: "https://gitlab.com/myorg/myrepo/-/blob/main/runbooks/setup-vpc/runbook.mdx",
			expected: &ParsedRemoteSource{
				Host:          "gitlab.com",
				Owner:         "myorg",
				Repo:          "myrepo",
				CloneURL:      "https://gitlab.com/myorg/myrepo.git",
				rawRefAndPath: "main/runbooks/setup-vpc/runbook.mdx",
			},
		},
		{
			name:  "plain repo URL",
			input: "https://gitlab.com/myorg/myrepo",
			expected: &ParsedRemoteSource{
				Host:     "gitlab.com",
				Owner:    "myorg",
				Repo:     "myrepo",
				CloneURL: "https://gitlab.com/myorg/myrepo.git",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			require.NoError(t, err)
			require.NotNil(t, result)
			assert.Equal(t, tt.expected.Host, result.Host)
			assert.Equal(t, tt.expected.Owner, result.Owner)
			assert.Equal(t, tt.expected.Repo, result.Repo)
			assert.Equal(t, tt.expected.Ref, result.Ref)
			assert.Equal(t, tt.expected.Path, result.Path)
			assert.Equal(t, tt.expected.CloneURL, result.CloneURL)
			assert.Equal(t, tt.expected.rawRefAndPath, result.rawRefAndPath)
		})
	}
}

func TestParseRemoteSource_TerraformGitHubShorthand(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected *ParsedRemoteSource
	}{
		{
			name:  "with path and ref",
			input: "github.com/gruntwork-io/runbooks//runbooks/setup-vpc?ref=v1.0",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				Ref:      "v1.0",
				Path:     "runbooks/setup-vpc",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "with path no ref",
			input: "github.com/gruntwork-io/runbooks//runbooks/setup-vpc",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				Path:     "runbooks/setup-vpc",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "repo only no path",
			input: "github.com/gruntwork-io/runbooks",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "with .git suffix",
			input: "github.com/gruntwork-io/runbooks.git//runbooks/setup-vpc?ref=main",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				Ref:      "main",
				Path:     "runbooks/setup-vpc",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			require.NoError(t, err)
			require.NotNil(t, result)
			assert.Equal(t, tt.expected.Host, result.Host)
			assert.Equal(t, tt.expected.Owner, result.Owner)
			assert.Equal(t, tt.expected.Repo, result.Repo)
			assert.Equal(t, tt.expected.Ref, result.Ref)
			assert.Equal(t, tt.expected.Path, result.Path)
			assert.Equal(t, tt.expected.CloneURL, result.CloneURL)
		})
	}
}

func TestParseRemoteSource_TerraformGitPrefix(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected *ParsedRemoteSource
	}{
		{
			name:  "GitHub with path and ref",
			input: "git::https://github.com/gruntwork-io/runbooks.git//runbooks/setup-vpc?ref=main",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "gruntwork-io",
				Repo:     "runbooks",
				Ref:      "main",
				Path:     "runbooks/setup-vpc",
				CloneURL: "https://github.com/gruntwork-io/runbooks.git",
			},
		},
		{
			name:  "GitLab with path and ref",
			input: "git::https://gitlab.com/myorg/myrepo.git//runbooks/setup-vpc?ref=v2.0",
			expected: &ParsedRemoteSource{
				Host:     "gitlab.com",
				Owner:    "myorg",
				Repo:     "myrepo",
				Ref:      "v2.0",
				Path:     "runbooks/setup-vpc",
				CloneURL: "https://gitlab.com/myorg/myrepo.git",
			},
		},
		{
			name:  "no path just ref",
			input: "git::https://github.com/org/repo.git?ref=v1.0",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "org",
				Repo:     "repo",
				Ref:      "v1.0",
				CloneURL: "https://github.com/org/repo.git",
			},
		},
		{
			name:  "no ref no path",
			input: "git::https://github.com/org/repo.git",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "org",
				Repo:     "repo",
				CloneURL: "https://github.com/org/repo.git",
			},
		},
		{
			name:  "without .git suffix",
			input: "git::https://github.com/org/repo//path?ref=main",
			expected: &ParsedRemoteSource{
				Host:     "github.com",
				Owner:    "org",
				Repo:     "repo",
				Ref:      "main",
				Path:     "path",
				CloneURL: "https://github.com/org/repo.git",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			require.NoError(t, err)
			require.NotNil(t, result)
			assert.Equal(t, tt.expected.Host, result.Host)
			assert.Equal(t, tt.expected.Owner, result.Owner)
			assert.Equal(t, tt.expected.Repo, result.Repo)
			assert.Equal(t, tt.expected.Ref, result.Ref)
			assert.Equal(t, tt.expected.Path, result.Path)
			assert.Equal(t, tt.expected.CloneURL, result.CloneURL)
		})
	}
}

func TestParseRemoteSource_LocalPaths(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"relative path", "./my-runbook"},
		{"absolute path", "/home/user/runbooks/setup-vpc"},
		{"simple directory", "my-runbook"},
		{"nested relative", "../other/runbook"},
		{"mdx file", "runbook.mdx"},
		{"path with spaces", "my runbook/dir"},
		{"empty string", ""},
		{"dot", "."},
		{"windows-style path", `C:\Users\me\runbooks`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			assert.NoError(t, err)
			assert.Nil(t, result, "expected nil for local path %q", tt.input)
		})
	}
}

func TestParseRemoteSource_InvalidURLs(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		errContains string
	}{
		{
			name:        "GitHub URL missing repo",
			input:       "https://github.com/gruntwork-io",
			errContains: "expected github.com/owner/repo",
		},
		{
			name:        "GitHub URL with tree but no ref",
			input:       "https://github.com/org/repo/tree",
			errContains: "missing ref",
		},
		{
			name:        "git:: prefix with no owner/repo",
			input:       "git::https://github.com/",
			errContains: "expected owner/repo",
		},
		{
			name:        "Terraform shorthand missing repo",
			input:       "github.com/onlyowner",
			errContains: "expected github.com/owner/repo",
		},
		{
			name:        "GitLab URL missing repo",
			input:       "https://gitlab.com/onlyowner",
			errContains: "expected gitlab.com/owner/repo",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			assert.Error(t, err)
			assert.Nil(t, result)
			assert.Contains(t, err.Error(), tt.errContains)
		})
	}
}

// =============================================================================
// ResolveRef tests
// =============================================================================

func TestResolveRef_SimpleRef(t *testing.T) {
	// We can't easily test the full ResolveRef with real git ls-remote,
	// but we can test the fallback behavior.
	ref, repoPath, err := resolveRefFallback("main/runbooks/setup-vpc", false)
	require.NoError(t, err)
	assert.Equal(t, "main", ref)
	assert.Equal(t, "runbooks/setup-vpc", repoPath)
}

func TestResolveRef_FallbackSingleSegment(t *testing.T) {
	ref, repoPath, err := resolveRefFallback("main", false)
	require.NoError(t, err)
	assert.Equal(t, "main", ref)
	assert.Equal(t, "", repoPath)
}

func TestResolveRef_FallbackBlobURL(t *testing.T) {
	ref, repoPath, err := resolveRefFallback("main/runbooks/setup-vpc/runbook.mdx", true)
	require.NoError(t, err)
	assert.Equal(t, "main", ref)
	assert.Equal(t, "runbooks/setup-vpc", repoPath)
}

func TestResolveRef_FallbackBlobURLSingleFile(t *testing.T) {
	ref, repoPath, err := resolveRefFallback("main/runbook.mdx", true)
	require.NoError(t, err)
	assert.Equal(t, "main", ref)
	assert.Equal(t, "", repoPath)
}

func TestAdjustBlobPath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"runbooks/setup-vpc/runbook.mdx", "runbooks/setup-vpc"},
		{"runbook.mdx", ""},
		{"deep/nested/path/file.mdx", "deep/nested/path"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.expected, AdjustBlobPath(tt.input))
		})
	}
}

func TestNeedsRefResolution(t *testing.T) {
	t.Run("browser URL needs resolution", func(t *testing.T) {
		result := &ParsedRemoteSource{
			rawRefAndPath: "main/path",
		}
		assert.True(t, result.NeedsRefResolution())
	})

	t.Run("terraform URL does not need resolution", func(t *testing.T) {
		result := &ParsedRemoteSource{
			Ref:  "v1.0",
			Path: "path",
		}
		assert.False(t, result.NeedsRefResolution())
	})

	t.Run("plain repo URL does not need resolution", func(t *testing.T) {
		result := &ParsedRemoteSource{
			Host:     "github.com",
			Owner:    "org",
			Repo:     "repo",
			CloneURL: "https://github.com/org/repo.git",
		}
		assert.False(t, result.NeedsRefResolution())
	})
}
