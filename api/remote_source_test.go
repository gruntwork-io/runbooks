package api

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// =============================================================================
// Test helpers
// =============================================================================

// assertParsedSourceEqual checks all fields of a ParsedRemoteSource match the expected values.
func assertParsedSourceEqual(t *testing.T, expected, actual *ParsedRemoteSource) {
	t.Helper()
	assert.Equal(t, expected.Host, actual.Host, "Host")
	assert.Equal(t, expected.Owner, actual.Owner, "Owner")
	assert.Equal(t, expected.Repo, actual.Repo, "Repo")
	assert.Equal(t, expected.Ref, actual.Ref, "Ref")
	assert.Equal(t, expected.Path, actual.Path, "Path")
	assert.Equal(t, expected.CloneURL, actual.CloneURL, "CloneURL")
	assert.Equal(t, expected.IsBlobURL, actual.IsBlobURL, "IsBlobURL")
	assert.Equal(t, expected.rawRefAndPath, actual.rawRefAndPath, "rawRefAndPath")
}

// =============================================================================
// ParseRemoteSource tests
// =============================================================================

func TestParseRemoteSource_GitHubBrowserURL(t *testing.T) {
	// For browser URLs (tree/blob), the ref and path are ambiguous
	// (e.g. "main/runbooks/setup-vpc" could split many ways), so
	// ParseRemoteSource stores them combined in rawRefAndPath.
	// Ref and Path stay empty until ResolveRef() queries the remote.
	// For that reason, we don't test Ref and Path in these tests.
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
				IsBlobURL:     true,
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
		{
			name:  "HTTP URL is accepted and CloneURL is normalized to HTTPS",
			input: "http://github.com/org/repo/tree/main/path",
			expected: &ParsedRemoteSource{
				Host:          "github.com",
				Owner:         "org",
				Repo:          "repo",
				CloneURL:      "https://github.com/org/repo.git",
				rawRefAndPath: "main/path",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseRemoteSource(tt.input)
			require.NoError(t, err)
			require.NotNil(t, result)
			assertParsedSourceEqual(t, tt.expected, result)
		})
	}
}

func TestParseRemoteSource_GitLabBrowserURL(t *testing.T) {
	// Same as GitHub: browser URLs leave Ref/Path empty in favor of
	// rawRefAndPath, which ResolveRef() splits later.
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
				IsBlobURL:     true,
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
			assertParsedSourceEqual(t, tt.expected, result)
		})
	}
}

func TestParseRemoteSource_TofuGitHubShorthand(t *testing.T) {
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
				// Ref empty: no ?ref= query parameter in the URL
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
				// Ref and Path empty: URL has no // path separator or ?ref= param
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
			assertParsedSourceEqual(t, tt.expected, result)
		})
	}
}

func TestParseRemoteSource_TofuGitPrefix(t *testing.T) {
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
				// Path empty: no // path separator in the URL
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
				// Ref and Path empty: URL has no // path separator or ?ref= param
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
			assertParsedSourceEqual(t, tt.expected, result)
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
			name:        "Tofu shorthand missing repo",
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
// Browser URL edge cases (GitHub vs GitLab action handling)
// =============================================================================

func TestParseRemoteSource_GitHubUnexpectedAction(t *testing.T) {
	// GitHub URLs with unexpected third segments (like /settings, /actions) should error
	result, err := ParseRemoteSource("https://github.com/org/repo/settings")
	assert.Error(t, err)
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "unexpected path segment")
}

func TestParseRemoteSource_GitLabUnknownAction(t *testing.T) {
	// GitLab URLs with unknown /-/<action> should be treated as plain repo URLs (no error)
	result, err := ParseRemoteSource("https://gitlab.com/org/repo/-/settings")
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "gitlab.com", result.Host)
	assert.Equal(t, "org", result.Owner)
	assert.Equal(t, "repo", result.Repo)
	assert.Empty(t, result.rawRefAndPath)
	assert.False(t, result.IsBlobURL)
}

// =============================================================================
// ResolveRef tests
// =============================================================================

func TestResolveRef_MatchesLongestRef(t *testing.T) {
	// Inject fake refs to test the matching logic without git ls-remote
	origFn := listRemoteRefsFn
	defer func() { listRemoteRefsFn = origFn }()

	tests := []struct {
		name            string
		refs            []string
		rawRefAndPath   string
		isBlobURL       bool
		expectedRef     string
		expectedPath    string
	}{
		{
			name:          "matches simple ref",
			refs:          []string{"main", "develop"},
			rawRefAndPath: "main/runbooks/setup-vpc",
			expectedRef:   "main",
			expectedPath:  "runbooks/setup-vpc",
		},
		{
			name:          "prefers longest matching ref",
			refs:          []string{"main", "main/dev"},
			rawRefAndPath: "main/dev/some/path",
			expectedRef:   "main/dev",
			expectedPath:  "some/path",
		},
		{
			name:          "exact match with no remaining path",
			refs:          []string{"v1.0", "v1.0.1"},
			rawRefAndPath: "v1.0",
			expectedRef:   "v1.0",
			expectedPath:  "",
		},
		{
			name:          "shorter ref wins when longer ref does not match",
			refs:          []string{"release/v2", "main"},
			rawRefAndPath: "main/deep/path",
			expectedRef:   "main",
			expectedPath:  "deep/path",
		},
		{
			name:          "no ref matches falls back to first segment",
			refs:          []string{"develop", "staging"},
			rawRefAndPath: "main/some/path",
			expectedRef:   "main",
			expectedPath:  "some/path",
		},
		{
			name:          "blob URL adjusts path to parent directory",
			refs:          []string{"main"},
			rawRefAndPath: "main/runbooks/setup-vpc/runbook.mdx",
			isBlobURL:     true,
			expectedRef:   "main",
			expectedPath:  "runbooks/setup-vpc",
		},
		{
			name:          "blob URL with single file adjusts to empty path",
			refs:          []string{"main"},
			rawRefAndPath: "main/runbook.mdx",
			isBlobURL:     true,
			expectedRef:   "main",
			expectedPath:  "",
		},
		{
			name:          "empty refs list falls back to first segment",
			refs:          []string{},
			rawRefAndPath: "v1.0/path/to/runbook",
			expectedRef:   "v1.0",
			expectedPath:  "path/to/runbook",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			listRemoteRefsFn = func(cloneURL string) ([]string, error) {
				return tt.refs, nil
			}

			ref, repoPath, err := ResolveRef("https://fake.com/repo.git", tt.rawRefAndPath, tt.isBlobURL)
			require.NoError(t, err)
			assert.Equal(t, tt.expectedRef, ref, "ref")
			assert.Equal(t, tt.expectedPath, repoPath, "repoPath")
		})
	}
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

// =============================================================================
// Resolve tests (ParseRemoteSource → Resolve integration)
// =============================================================================

func TestResolve(t *testing.T) {
	origFn := listRemoteRefsFn
	defer func() { listRemoteRefsFn = origFn }()

	t.Run("browser tree URL resolves ref and path", func(t *testing.T) {
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			return []string{"main", "develop"}, nil
		}

		parsed, err := ParseRemoteSource("https://github.com/org/repo/tree/main/infra/vpc")
		require.NoError(t, err)
		require.NotNil(t, parsed)
		assert.True(t, parsed.NeedsRefResolution(), "should need resolution before Resolve()")

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Equal(t, "main", parsed.Ref)
		assert.Equal(t, "infra/vpc", parsed.Path)
		assert.False(t, parsed.NeedsRefResolution(), "should not need resolution after Resolve()")
	})

	t.Run("browser blob URL resolves ref and adjusts path to parent dir", func(t *testing.T) {
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			return []string{"main"}, nil
		}

		parsed, err := ParseRemoteSource("https://github.com/org/repo/blob/main/infra/vpc/runbook.mdx")
		require.NoError(t, err)
		require.NotNil(t, parsed)
		assert.True(t, parsed.IsBlobURL)

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Equal(t, "main", parsed.Ref)
		assert.Equal(t, "infra/vpc", parsed.Path, "blob path should be adjusted to parent directory")
	})

	t.Run("ambiguous ref resolves to longest matching ref", func(t *testing.T) {
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			return []string{"main", "main/dev"}, nil
		}

		parsed, err := ParseRemoteSource("https://github.com/org/repo/tree/main/dev/some/path")
		require.NoError(t, err)

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Equal(t, "main/dev", parsed.Ref)
		assert.Equal(t, "some/path", parsed.Path)
	})

	t.Run("GitLab browser URL resolves ref and path", func(t *testing.T) {
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			return []string{"main"}, nil
		}

		parsed, err := ParseRemoteSource("https://gitlab.com/myorg/myrepo/-/tree/main/runbooks/vpc")
		require.NoError(t, err)

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Equal(t, "main", parsed.Ref)
		assert.Equal(t, "runbooks/vpc", parsed.Path)
	})

	t.Run("Tofu URL with ref already set is a no-op", func(t *testing.T) {
		parsed, err := ParseRemoteSource("github.com/org/repo//infra/vpc?ref=v1.0")
		require.NoError(t, err)

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Equal(t, "v1.0", parsed.Ref)
		assert.Equal(t, "infra/vpc", parsed.Path)
	})

	t.Run("plain repo URL is a no-op", func(t *testing.T) {
		parsed, err := ParseRemoteSource("https://github.com/org/repo")
		require.NoError(t, err)

		err = parsed.Resolve("")
		require.NoError(t, err)

		assert.Empty(t, parsed.Ref)
		assert.Empty(t, parsed.Path)
	})

	t.Run("token is injected into clone URL for ls-remote", func(t *testing.T) {
		var capturedURL string
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			capturedURL = cloneURL
			return []string{"main"}, nil
		}

		parsed, err := ParseRemoteSource("https://github.com/org/repo/tree/main/path")
		require.NoError(t, err)

		err = parsed.Resolve("ghp_testtoken")
		require.NoError(t, err)

		assert.Contains(t, capturedURL, "x-access-token:ghp_testtoken@",
			"token should be injected into the clone URL passed to ls-remote")
	})

	t.Run("ls-remote failure returns error instead of silently falling back", func(t *testing.T) {
		listRemoteRefsFn = func(cloneURL string) ([]string, error) {
			return nil, fmt.Errorf("authentication failed")
		}

		parsed, err := ParseRemoteSource("https://github.com/org/repo/tree/v2.0/deep/nested/path")
		require.NoError(t, err)

		err = parsed.Resolve("")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "authentication failed")
		assert.Empty(t, parsed.Ref, "ref should not be set when ls-remote fails")
		assert.Empty(t, parsed.Path, "path should not be set when ls-remote fails")
	})
}

