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
	// Empty for OpenTofu-style URLs where ref and path are already separated.
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

// Resolve separates the git ref from the repo path when they're ambiguous.
//
// Browser URLs like github.com/org/repo/tree/main/infra/vpc embed the ref and
// path together as "main/infra/vpc". This could mean ref="main" path="infra/vpc",
// or ref="main/infra" path="vpc" if a branch named "main/infra" exists. Resolve
// uses git ls-remote to find the correct split.
//
// For blob URLs (pointing to a file rather than a directory), the path is also
// adjusted to the parent directory, since runbooks live in directories.
//
// token is used to authenticate the ls-remote call if non-empty.
func (p *ParsedRemoteSource) Resolve(token string) error {
	if p.NeedsRefResolution() {
		cloneURL := InjectGitToken(p.CloneURL, token)
		ref, repoPath := ResolveRef(cloneURL, p.RawRefAndPath(), p.IsBlobURL)
		p.Ref = ref
		p.Path = repoPath
	} else if p.IsBlobURL && p.Path != "" {
		p.Path = AdjustBlobPath(p.Path)
	}
	return nil
}

// ParseRemoteSource parses any supported remote URL format into a normalized form.
// Returns nil, nil if the input is not a remote source (i.e., it's a local path).
// Returns nil, error if it looks like a remote source but is malformed.
//
// Supported formats:
//   - git::https://host/owner/repo.git//path?ref=v1.0  (OpenTofu git:: prefix)
//   - github.com/owner/repo//path?ref=v1.0             (OpenTofu GitHub shorthand)
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

	lowered := strings.ToLower(raw)

	// 1. git::https:// or git::http:// prefix (OpenTofu generic git source)
	if strings.HasPrefix(lowered, "git::https://") || strings.HasPrefix(lowered, "git::http://") {
		return parseGitPrefixURL(raw)
	}

	// 2. github.com/ without scheme (OpenTofu GitHub shorthand)
	if strings.HasPrefix(lowered, "github.com/") {
		return parseGitHubShorthand(raw)
	}

	// 3. https://github.com/ or http://github.com/ (GitHub browser URL)
	if strings.HasPrefix(lowered, "https://github.com/") || strings.HasPrefix(lowered, "http://github.com/") {
		return parseBrowserURL(raw, "github.com")
	}

	// 4. https://gitlab.com/ or http://gitlab.com/ (GitLab browser URL)
	if strings.HasPrefix(lowered, "https://gitlab.com/") || strings.HasPrefix(lowered, "http://gitlab.com/") {
		return parseBrowserURL(raw, "gitlab.com")
	}

	// Not a recognized remote source — treat as local path
	return nil, nil
}

// --- OpenTofu-style URL parsers (git:: prefix and GitHub shorthand) ---

// parseGitPrefixURL parses an OpenTofu git::https:// URL.
// Format: git::https://host/owner/repo.git//path?ref=v1.0
func parseGitPrefixURL(raw string) (*ParsedRemoteSource, error) {
	rawURL := strings.TrimPrefix(raw, "git::")

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid git URL %q: %w", raw, err)
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return nil, fmt.Errorf("invalid git URL %q: missing host", raw)
	}

	owner, repo, subPath, err := splitTofuSourcePath(parsed.Path, raw, "expected owner/repo in path")
	if err != nil {
		return nil, err
	}

	return &ParsedRemoteSource{
		Host:     host,
		Owner:    owner,
		Repo:     repo,
		Ref:      parsed.Query().Get("ref"),
		Path:     subPath,
		CloneURL: fmt.Sprintf("https://%s/%s/%s.git", host, owner, repo),
	}, nil
}

// parseGitHubShorthand parses an OpenTofu GitHub shorthand URL.
// Format: github.com/owner/repo//path?ref=v1.0
func parseGitHubShorthand(raw string) (*ParsedRemoteSource, error) {
	parsed, err := url.Parse("https://" + raw)
	if err != nil {
		return nil, fmt.Errorf("invalid GitHub source %q: %w", raw, err)
	}

	owner, repo, subPath, err := splitTofuSourcePath(parsed.Path, raw, "expected github.com/owner/repo")
	if err != nil {
		return nil, err
	}

	return &ParsedRemoteSource{
		Host:     "github.com",
		Owner:    owner,
		Repo:     repo,
		Ref:      parsed.Query().Get("ref"),
		Path:     subPath,
		CloneURL: fmt.Sprintf("https://github.com/%s/%s.git", owner, repo),
	}, nil
}

// splitTofuSourcePath extracts owner, repo, and sub-path from a URL path
// that uses the OpenTofu // separator convention (e.g., /owner/repo.git//sub/path).
func splitTofuSourcePath(urlPath, rawInput, errHint string) (owner, repo, subPath string, err error) {
	fullPath := strings.TrimPrefix(urlPath, "/")
	fullPath = strings.TrimSuffix(fullPath, "/")

	var repoPath string
	if idx := strings.Index(fullPath, "//"); idx >= 0 {
		repoPath = fullPath[:idx]
		subPath = strings.TrimPrefix(fullPath[idx+2:], "/")
		subPath = strings.TrimSuffix(subPath, "/")
	} else {
		repoPath = fullPath
	}

	repoPath = strings.TrimSuffix(repoPath, ".git")
	parts := strings.SplitN(repoPath, "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", "", fmt.Errorf("invalid source %q: %s", rawInput, errHint)
	}

	return parts[0], parts[1], subPath, nil
}

// --- Browser URL parser (GitHub and GitLab) ---

// parseBrowserURL parses a GitHub or GitLab browser URL.
//
// GitHub formats:
//   - https://github.com/owner/repo/tree/ref/path
//   - https://github.com/owner/repo/blob/ref/path
//   - https://github.com/owner/repo
//
// GitLab formats:
//   - https://gitlab.com/owner/repo/-/tree/ref/path
//   - https://gitlab.com/owner/repo/-/blob/ref/path
//   - https://gitlab.com/owner/repo
func parseBrowserURL(raw string, host string) (*ParsedRemoteSource, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid %s URL %q: %w", host, raw, err)
	}

	pathStr := strings.TrimPrefix(parsed.Path, "/")
	pathStr = strings.TrimSuffix(pathStr, "/")

	segments := strings.Split(pathStr, "/")
	if len(segments) < 2 {
		return nil, fmt.Errorf("invalid %s URL %q: expected %s/owner/repo", host, raw, host)
	}

	owner := segments[0]
	repo := strings.TrimSuffix(segments[1], ".git")
	if owner == "" || repo == "" {
		return nil, fmt.Errorf("invalid %s URL %q: empty owner or repo", host, raw)
	}

	result := &ParsedRemoteSource{
		Host:     host,
		Owner:    owner,
		Repo:     repo,
		CloneURL: fmt.Sprintf("https://%s/%s/%s.git", host, owner, repo),
	}

	// Extract the tree/blob action and rawRefAndPath from remaining segments.
	// GitLab uses /-/tree/ while GitHub uses /tree/ directly.
	action, refAndPath, err := extractBrowserAction(segments[2:], host, raw)
	if err != nil {
		return nil, err
	}
	if action == "blob" {
		result.IsBlobURL = true
	}
	result.rawRefAndPath = refAndPath

	return result, nil
}

// extractBrowserAction parses the segments after owner/repo to find the tree/blob
// action and the ref+path string. Returns empty strings if there's no action.
func extractBrowserAction(segments []string, host, raw string) (action, refAndPath string, err error) {
	if len(segments) == 0 {
		return "", "", nil
	}

	// GitLab uses /-/ before tree/blob; skip it
	if segments[0] == "-" {
		segments = segments[1:]
		if len(segments) == 0 {
			return "", "", nil
		}
	}

	action = segments[0]
	switch action {
	case "tree", "blob":
		remaining := segments[1:]
		if len(remaining) == 0 {
			return "", "", fmt.Errorf("invalid %s URL %q: missing ref after /%s/", host, raw, action)
		}
		return action, strings.Join(remaining, "/"), nil
	default:
		// For GitHub: unexpected third segment like /settings or /actions
		// For GitLab: unknown action after /-/
		if host == "github.com" {
			return "", "", fmt.Errorf("invalid %s URL %q: unexpected path segment /%s/", host, raw, action)
		}
		// GitLab: treat unknown /-/<action> as plain repo URL
		return "", "", nil
	}
}

// --- Ref resolution ---

// ResolveRef uses git ls-remote to resolve the ref from a browser URL's ambiguous
// ref+path segment (e.g., "main/runbooks/setup-vpc" could be ref="main" path="runbooks/setup-vpc"
// or ref="main/runbooks" path="setup-vpc" if a branch named "main/runbooks" exists).
//
// cloneURL should already have the token injected if auth is needed.
// rawRefAndPath is the segment after /tree/ or /blob/ in the browser URL.
// isBlobURL indicates whether the original URL used /blob/ (path points to a file).
//
// Returns the resolved ref name and the remaining path within the repo.
// Always succeeds: if ls-remote fails or no ref matches, falls back to the first path segment.
func ResolveRef(cloneURL, rawRefAndPath string, isBlobURL bool) (ref string, repoPath string) {
	if rawRefAndPath == "" {
		return "", ""
	}

	// Get all refs from the remote
	refs, err := listRemoteRefsFn(cloneURL)
	if err != nil {
		return resolveRefFallback(rawRefAndPath, isBlobURL)
	}

	// Sort refs by length descending so we find the longest match first
	sort.Slice(refs, func(i, j int) bool {
		return len(refs[i]) > len(refs[j])
	})

	// Find the longest ref that matches the beginning of rawRefAndPath
	for _, r := range refs {
		if rawRefAndPath == r {
			return r, ""
		}
		if strings.HasPrefix(rawRefAndPath, r+"/") {
			remaining := strings.TrimPrefix(rawRefAndPath, r+"/")
			remaining = strings.TrimSuffix(remaining, "/")
			if isBlobURL {
				remaining = AdjustBlobPath(remaining)
			}
			return r, remaining
		}
	}

	return resolveRefFallback(rawRefAndPath, isBlobURL)
}

// resolveRefFallback splits rawRefAndPath using the first segment as the ref.
// This never fails — it always produces a best-effort split.
func resolveRefFallback(rawRefAndPath string, isBlobURL bool) (string, string) {
	parts := strings.SplitN(rawRefAndPath, "/", 2)
	ref := parts[0]
	repoPath := ""
	if len(parts) > 1 {
		repoPath = strings.TrimSuffix(parts[1], "/")
	}
	if isBlobURL {
		repoPath = AdjustBlobPath(repoPath)
	}
	return ref, repoPath
}

// AdjustBlobPath adjusts a path from a /blob/ URL to point to the parent directory.
// For example, "runbooks/setup-vpc/runbook.mdx" becomes "runbooks/setup-vpc".
// Uses path.Dir (POSIX) intentionally since these are URL/repo paths, not filesystem paths.
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

// listRemoteRefsFn is the function used to list remote refs.
// It is a variable so tests can inject a fake implementation.
var listRemoteRefsFn = listRemoteRefsImpl

// listRemoteRefsImpl runs git ls-remote and returns a list of ref names
// (with refs/heads/ and refs/tags/ prefixes stripped).
func listRemoteRefsImpl(cloneURL string) ([]string, error) {
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
