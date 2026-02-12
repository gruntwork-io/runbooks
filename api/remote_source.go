package api

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"path"
	"sort"
	"strings"
	"time"
)

// ParsedRemoteSource is the normalized result of parsing any remote URL format.
// It represents a runbook located in a remote git repository.
type ParsedRemoteSource struct {
	Host     string // "github.com" or "gitlab.com"
	Owner    string // "gruntwork-io"
	Repo     string // "runbooks"
	Ref      string // "main", "v1.0" — empty if not yet resolved
	Path     string // "runbooks/setup-vpc" — path within the repo to the runbook dir
	CloneURL string // "https://github.com/gruntwork-io/runbooks.git"

	// IsBlobURL is true when the URL used /blob/ instead of /tree/.
	// This means the path points to a file (e.g., runbook.mdx) rather than a directory,
	// and ResolveRef should adjust the path to the parent directory.
	IsBlobURL bool

	// rawRefAndPath is the unresolved ref+path segment from browser URLs.
	// For browser URLs like /tree/main/path, this is "main/path" and needs
	// ResolveRef() to split it into Ref and Path.
	// Empty for Terraform-style URLs where ref and path are already separated.
	rawRefAndPath string
}

// NeedsRefResolution returns true if the ref has not been resolved yet
// (browser URLs where ref is embedded in the path).
func (p *ParsedRemoteSource) NeedsRefResolution() bool {
	return p.rawRefAndPath != "" && p.Ref == ""
}

// RawRefAndPath returns the unresolved ref+path segment for browser URLs.
func (p *ParsedRemoteSource) RawRefAndPath() string {
	return p.rawRefAndPath
}

// ParseRemoteSource parses any supported remote URL format into a normalized form.
// Returns nil, nil if the input is not a remote source (i.e., it's a local path).
// Returns nil, error if it looks like a remote source but is malformed.
//
// Supported formats:
//   - git::https://host/owner/repo.git//path?ref=v1.0  (Terraform git:: prefix)
//   - github.com/owner/repo//path?ref=v1.0             (Terraform GitHub shorthand)
//   - https://github.com/owner/repo/tree/ref/path      (GitHub browser URL)
//   - https://github.com/owner/repo/blob/ref/file.mdx  (GitHub blob URL)
//   - https://gitlab.com/owner/repo/-/tree/ref/path    (GitLab browser URL)
//   - https://gitlab.com/owner/repo/-/blob/ref/file.mdx (GitLab blob URL)
//   - https://github.com/owner/repo                     (plain repo URL)
func ParseRemoteSource(raw string) (*ParsedRemoteSource, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	// 1. git::https:// prefix (Terraform generic git source)
	if strings.HasPrefix(raw, "git::https://") {
		return parseGitPrefixURL(raw)
	}
	if strings.HasPrefix(raw, "git::http://") {
		return parseGitPrefixURL(raw)
	}

	// 2. github.com/ without scheme (Terraform GitHub shorthand)
	if strings.HasPrefix(raw, "github.com/") {
		return parseTerraformGitHubShorthand(raw)
	}

	// 3. https://github.com/ (GitHub browser URL)
	if strings.HasPrefix(strings.ToLower(raw), "https://github.com/") || strings.HasPrefix(strings.ToLower(raw), "http://github.com/") {
		return parseGitHubBrowserURL(raw)
	}

	// 4. https://gitlab.com/ (GitLab browser URL)
	if strings.HasPrefix(strings.ToLower(raw), "https://gitlab.com/") || strings.HasPrefix(strings.ToLower(raw), "http://gitlab.com/") {
		return parseGitLabBrowserURL(raw)
	}

	// Not a recognized remote source — treat as local path
	return nil, nil
}

// parseGitPrefixURL parses a Terraform git::https:// URL.
// Format: git::https://host/owner/repo.git//path?ref=v1.0
func parseGitPrefixURL(raw string) (*ParsedRemoteSource, error) {
	// Strip the "git::" prefix
	rawURL := strings.TrimPrefix(raw, "git::")

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid git URL %q: %w", raw, err)
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return nil, fmt.Errorf("invalid git URL %q: missing host", raw)
	}

	// Extract ref from query params
	ref := parsed.Query().Get("ref")

	// The path may contain // to separate repo path from sub-path
	// e.g., /owner/repo.git//subdir
	fullPath := strings.TrimPrefix(parsed.Path, "/")
	fullPath = strings.TrimSuffix(fullPath, "/")

	var repoPath, subPath string
	if idx := strings.Index(fullPath, "//"); idx >= 0 {
		repoPath = fullPath[:idx]
		subPath = strings.TrimPrefix(fullPath[idx+2:], "/")
		subPath = strings.TrimSuffix(subPath, "/")
	} else {
		repoPath = fullPath
	}

	// Parse owner/repo from the repo path
	repoPath = strings.TrimSuffix(repoPath, ".git")
	parts := strings.SplitN(repoPath, "/", 3)
	if len(parts) < 2 {
		return nil, fmt.Errorf("invalid git URL %q: expected owner/repo in path", raw)
	}
	owner := parts[0]
	repo := parts[1]

	if owner == "" || repo == "" {
		return nil, fmt.Errorf("invalid git URL %q: empty owner or repo", raw)
	}

	cloneURL := fmt.Sprintf("https://%s/%s/%s.git", host, owner, repo)

	return &ParsedRemoteSource{
		Host:     host,
		Owner:    owner,
		Repo:     repo,
		Ref:      ref,
		Path:     subPath,
		CloneURL: cloneURL,
	}, nil
}

// parseTerraformGitHubShorthand parses a Terraform GitHub shorthand URL.
// Format: github.com/owner/repo//path?ref=v1.0
func parseTerraformGitHubShorthand(raw string) (*ParsedRemoteSource, error) {
	// Add https:// scheme so we can use url.Parse
	withScheme := "https://" + raw

	parsed, err := url.Parse(withScheme)
	if err != nil {
		return nil, fmt.Errorf("invalid GitHub source %q: %w", raw, err)
	}

	ref := parsed.Query().Get("ref")

	fullPath := strings.TrimPrefix(parsed.Path, "/")
	fullPath = strings.TrimSuffix(fullPath, "/")

	var repoPath, subPath string
	if idx := strings.Index(fullPath, "//"); idx >= 0 {
		repoPath = fullPath[:idx]
		subPath = strings.TrimPrefix(fullPath[idx+2:], "/")
		subPath = strings.TrimSuffix(subPath, "/")
	} else {
		repoPath = fullPath
	}

	repoPath = strings.TrimSuffix(repoPath, ".git")
	parts := strings.SplitN(repoPath, "/", 3)
	if len(parts) < 2 {
		return nil, fmt.Errorf("invalid GitHub source %q: expected github.com/owner/repo", raw)
	}
	owner := parts[0]
	repo := parts[1]

	if owner == "" || repo == "" {
		return nil, fmt.Errorf("invalid GitHub source %q: empty owner or repo", raw)
	}

	cloneURL := fmt.Sprintf("https://github.com/%s/%s.git", owner, repo)

	return &ParsedRemoteSource{
		Host:     "github.com",
		Owner:    owner,
		Repo:     repo,
		Ref:      ref,
		Path:     subPath,
		CloneURL: cloneURL,
	}, nil
}

// parseGitHubBrowserURL parses a GitHub browser URL.
// Formats:
//   - https://github.com/owner/repo/tree/ref/path
//   - https://github.com/owner/repo/blob/ref/path
//   - https://github.com/owner/repo
func parseGitHubBrowserURL(raw string) (*ParsedRemoteSource, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid GitHub URL %q: %w", raw, err)
	}

	pathStr := strings.TrimPrefix(parsed.Path, "/")
	pathStr = strings.TrimSuffix(pathStr, "/")

	segments := strings.SplitN(pathStr, "/", 4)
	if len(segments) < 2 {
		return nil, fmt.Errorf("invalid GitHub URL %q: expected github.com/owner/repo", raw)
	}

	owner := segments[0]
	repo := strings.TrimSuffix(segments[1], ".git")

	if owner == "" || repo == "" {
		return nil, fmt.Errorf("invalid GitHub URL %q: empty owner or repo", raw)
	}

	cloneURL := fmt.Sprintf("https://github.com/%s/%s.git", owner, repo)

	result := &ParsedRemoteSource{
		Host:     "github.com",
		Owner:    owner,
		Repo:     repo,
		CloneURL: cloneURL,
	}

	// If there are more segments, look for tree/ or blob/
	if len(segments) >= 4 {
		action := segments[2] // "tree" or "blob"
		rawRefAndPath := segments[3]

		switch action {
		case "tree":
			result.rawRefAndPath = rawRefAndPath
		case "blob":
			result.rawRefAndPath = rawRefAndPath
			result.IsBlobURL = true
		default:
			return nil, fmt.Errorf("invalid GitHub URL %q: expected /tree/ or /blob/ in path, got /%s/", raw, action)
		}
	} else if len(segments) == 3 {
		// Could be github.com/owner/repo/tree without further path — treat as malformed
		action := segments[2]
		if action == "tree" || action == "blob" {
			return nil, fmt.Errorf("invalid GitHub URL %q: missing ref after /%s/", raw, action)
		}
		// Otherwise it's something unexpected
		return nil, fmt.Errorf("invalid GitHub URL %q: unexpected path segment /%s/", raw, action)
	}
	// len(segments) == 2 means just owner/repo, which is fine (no ref/path)

	return result, nil
}

// parseGitLabBrowserURL parses a GitLab browser URL.
// Formats:
//   - https://gitlab.com/owner/repo/-/tree/ref/path
//   - https://gitlab.com/owner/repo/-/blob/ref/path
//   - https://gitlab.com/owner/repo
func parseGitLabBrowserURL(raw string) (*ParsedRemoteSource, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid GitLab URL %q: %w", raw, err)
	}

	pathStr := strings.TrimPrefix(parsed.Path, "/")
	pathStr = strings.TrimSuffix(pathStr, "/")

	// GitLab paths: owner/repo/-/tree/ref/path or owner/repo/-/blob/ref/path
	// Split into segments
	segments := strings.Split(pathStr, "/")
	if len(segments) < 2 {
		return nil, fmt.Errorf("invalid GitLab URL %q: expected gitlab.com/owner/repo", raw)
	}

	owner := segments[0]
	repo := strings.TrimSuffix(segments[1], ".git")

	if owner == "" || repo == "" {
		return nil, fmt.Errorf("invalid GitLab URL %q: empty owner or repo", raw)
	}

	cloneURL := fmt.Sprintf("https://gitlab.com/%s/%s.git", owner, repo)

	result := &ParsedRemoteSource{
		Host:     "gitlab.com",
		Owner:    owner,
		Repo:     repo,
		CloneURL: cloneURL,
	}

	// Look for /-/tree/ or /-/blob/ pattern
	// segments: [owner, repo, "-", "tree"|"blob", ref..., path...]
	if len(segments) >= 5 && segments[2] == "-" {
		action := segments[3]
		switch action {
		case "tree":
			result.rawRefAndPath = strings.Join(segments[4:], "/")
		case "blob":
			result.rawRefAndPath = strings.Join(segments[4:], "/")
			result.IsBlobURL = true
		default:
			// Unknown action after /-/, treat as plain repo URL
		}
	}

	return result, nil
}

// ResolveRef uses git ls-remote to resolve the ref from a browser URL's ambiguous
// ref+path segment (e.g., "main/runbooks/setup-vpc" could be ref="main" path="runbooks/setup-vpc"
// or ref="main/runbooks" path="setup-vpc" if a branch named "main/runbooks" exists).
//
// cloneURL should already have the token injected if auth is needed.
// rawRefAndPath is the segment after /tree/ or /blob/ in the browser URL.
// isBlobURL indicates whether the original URL used /blob/ (path points to a file).
//
// Returns the resolved ref name and the remaining path within the repo.
func ResolveRef(cloneURL, rawRefAndPath string, isBlobURL bool) (ref string, repoPath string, err error) {
	if rawRefAndPath == "" {
		return "", "", nil
	}

	// Get all refs from the remote
	refs, err := listRemoteRefs(cloneURL)
	if err != nil {
		// If ls-remote fails (e.g., no auth), fall back to first segment as ref
		return resolveRefFallback(rawRefAndPath, isBlobURL)
	}

	// Sort refs by length descending so we find the longest match first
	sort.Slice(refs, func(i, j int) bool {
		return len(refs[i]) > len(refs[j])
	})

	// Find the longest ref that matches the beginning of rawRefAndPath
	for _, r := range refs {
		if rawRefAndPath == r {
			// Exact match — entire rawRefAndPath is the ref, no remaining path
			return r, "", nil
		}
		if strings.HasPrefix(rawRefAndPath, r+"/") {
			remaining := strings.TrimPrefix(rawRefAndPath, r+"/")
			remaining = strings.TrimSuffix(remaining, "/")
			if isBlobURL {
				remaining = AdjustBlobPath(remaining)
			}
			return r, remaining, nil
		}
	}

	// No ref matched — fall back to first segment
	return resolveRefFallback(rawRefAndPath, isBlobURL)
}

// resolveRefFallback splits rawRefAndPath using the first segment as the ref.
func resolveRefFallback(rawRefAndPath string, isBlobURL bool) (string, string, error) {
	parts := strings.SplitN(rawRefAndPath, "/", 2)
	ref := parts[0]
	repoPath := ""
	if len(parts) > 1 {
		repoPath = strings.TrimSuffix(parts[1], "/")
	}
	if isBlobURL {
		repoPath = AdjustBlobPath(repoPath)
	}
	return ref, repoPath, nil
}

// AdjustBlobPath adjusts a path from a /blob/ URL to point to the parent directory.
// For example, "runbooks/setup-vpc/runbook.mdx" becomes "runbooks/setup-vpc".
func AdjustBlobPath(p string) string {
	if p == "" {
		return ""
	}
	dir := path.Dir(p)
	if dir == "." {
		return ""
	}
	return dir
}

// listRemoteRefs runs git ls-remote and returns a list of ref names
// (with refs/heads/ and refs/tags/ prefixes stripped).
func listRemoteRefs(cloneURL string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "ls-remote", "--heads", "--tags", "--refs", cloneURL)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git ls-remote failed: %w", err)
	}

	var refs []string
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Format: <sha>\t<ref>
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		refName := parts[1]
		refName = strings.TrimPrefix(refName, "refs/heads/")
		refName = strings.TrimPrefix(refName, "refs/tags/")
		refs = append(refs, refName)
	}

	return refs, nil
}
