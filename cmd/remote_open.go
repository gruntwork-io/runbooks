package cmd

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"runbooks/api"
)

// resolveRemoteSource checks if the given source is a remote URL.
// If so, downloads the runbook to a temp directory and returns the local path + cleanup func + original remote URL.
// If not a remote source, returns the original path unchanged with nil cleanup and empty remoteURL.
func resolveRemoteSource(source string) (localPath string, cleanup func(), remoteURL string, err error) {
	parsed, err := api.ParseRemoteSource(source)
	if err != nil {
		return "", nil, "", fmt.Errorf("invalid remote source %q: %w", source, err)
	}
	if parsed == nil {
		// Not a remote source — treat as local path
		return source, nil, "", nil
	}

	localPath, cleanup, err = fetchRemoteRunbook(parsed, source)
	if err != nil {
		return "", nil, "", err
	}
	return localPath, cleanup, source, nil
}

// fetchRemoteRunbook downloads a runbook from a remote source to a temp directory.
func fetchRemoteRunbook(parsed *api.ParsedRemoteSource, rawSource string) (string, func(), error) {
	// Verify git is available
	if _, err := exec.LookPath("git"); err != nil {
		return "", nil, fmt.Errorf("git is required to download remote runbooks but was not found on PATH")
	}

	// Get auth token for the host
	token := api.GetTokenForHost(parsed.Host)

	// Resolve ref if needed (browser URLs where ref is embedded in the path)
	if parsed.NeedsRefResolution() {
		cloneURLForLsRemote := parsed.CloneURL
		if token != "" {
			cloneURLForLsRemote = api.InjectGitHubToken(parsed.CloneURL, token)
		}

		ref, repoPath, err := api.ResolveRef(cloneURLForLsRemote, parsed.RawRefAndPath(), parsed.IsBlobURL)
		if err != nil {
			return "", nil, fmt.Errorf("could not resolve branch or tag from URL — verify the URL points to a valid branch or tag: %w", err)
		}
		parsed.Ref = ref
		parsed.Path = repoPath
	} else if parsed.IsBlobURL && parsed.Path != "" {
		// For Terraform-style blob URLs (unlikely but handle gracefully),
		// adjust path to parent directory
		parsed.Path = api.AdjustBlobPath(parsed.Path)
	}

	// Create temp directory
	tempDir, err := os.MkdirTemp("", "runbook-remote-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}

	cleanup := func() {
		os.RemoveAll(tempDir)
	}

	// On error, clean up the temp dir
	success := false
	defer func() {
		if !success {
			cleanup()
		}
	}()

	// Print progress
	fmt.Fprintf(os.Stderr, "Downloading runbook from %s/%s/%s...\n", parsed.Host, parsed.Owner, parsed.Repo)

	// Inject token if available
	cloneURL := parsed.CloneURL
	if token != "" {
		cloneURL = api.InjectGitHubToken(parsed.CloneURL, token)
	}

	// Clone with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if parsed.Path != "" {
		// Sparse clone — only download the specified subdirectory
		slog.Info("Sparse cloning remote runbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref, "path", parsed.Path)
		output, cloneErr := api.GitSparseCloneSimple(ctx, cloneURL, tempDir, parsed.Path, parsed.Ref)
		if cloneErr != nil {
			return "", nil, classifyCloneError(cloneErr, output, token, parsed)
		}
	} else {
		// Full clone — download entire repo
		slog.Info("Cloning remote runbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref)
		output, cloneErr := api.GitCloneSimple(ctx, cloneURL, tempDir, parsed.Ref)
		if cloneErr != nil {
			return "", nil, classifyCloneError(cloneErr, output, token, parsed)
		}
	}

	// Determine the actual runbook directory
	runbookDir := tempDir
	if parsed.Path != "" {
		runbookDir = filepath.Join(tempDir, parsed.Path)
	}

	// Validate that the directory contains a runbook.mdx
	resolvedPath, err := api.ResolveRunbookPath(runbookDir)
	if err != nil {
		pathDesc := parsed.Path
		if pathDesc == "" {
			pathDesc = "(repo root)"
		}
		return "", nil, fmt.Errorf("no runbook found at the specified path — expected runbook.mdx in %s", pathDesc)
	}

	// Size guard: warn if total size exceeds 50MB
	warnIfLarge(tempDir)

	fmt.Fprintf(os.Stderr, "Runbook downloaded successfully.\n")
	slog.Info("Remote runbook resolved", "path", resolvedPath)

	success = true
	return runbookDir, cleanup, nil
}

// classifyCloneError examines a git clone error and returns a user-friendly message.
func classifyCloneError(cloneErr error, output []byte, token string, parsed *api.ParsedRemoteSource) error {
	errMsg := cloneErr.Error()
	if output != nil {
		errMsg = string(output) + " " + errMsg
	}
	sanitized := api.SanitizeGitError(errMsg)

	// Check for auth-related errors when no token was provided
	if token == "" && isAuthError(sanitized) {
		tokenVar, cliCmd := authHintForHost(parsed.Host)
		return fmt.Errorf("authentication required for %s/%s/%s: set %s, or run '%s'",
			parsed.Host, parsed.Owner, parsed.Repo, tokenVar, cliCmd)
	}

	return fmt.Errorf("failed to download runbook: %s", sanitized)
}

// isAuthError checks if a git error message indicates an authentication failure.
func isAuthError(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "authentication failed") ||
		strings.Contains(lower, "could not read username") ||
		strings.Contains(lower, "http 404") ||
		strings.Contains(lower, "repository not found") ||
		strings.Contains(lower, "fatal: could not read") ||
		strings.Contains(lower, "403")
}

// authHintForHost returns the environment variable name and CLI command for auth.
func authHintForHost(host string) (tokenVar, cliCmd string) {
	switch strings.ToLower(host) {
	case "gitlab.com":
		return "GITLAB_TOKEN", "glab auth login"
	default:
		return "GITHUB_TOKEN", "gh auth login"
	}
}

// warnIfLarge walks a directory and warns to stderr if total size exceeds 50MB.
func warnIfLarge(dir string) {
	var totalSize int64
	filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			totalSize += info.Size()
		}
		return nil
	})

	const warnThreshold = 50 * 1024 * 1024 // 50MB
	if totalSize > warnThreshold {
		fmt.Fprintf(os.Stderr, "Warning: downloaded runbook is large (%d MB)\n", totalSize/(1024*1024))
	}
}
