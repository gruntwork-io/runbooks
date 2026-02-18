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

	"github.com/spf13/cobra"
)

// validateSourceArg is a Cobra Args validator that provides a clear error when RUNBOOK_SOURCE is missing.
func validateSourceArg(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("missing required argument: RUNBOOK_SOURCE\n\nProvide a local path or remote URL to a runbook:\n  %s /path/to/runbook\n  %s https://github.com/org/repo/tree/main/runbooks/my-runbook\n", cmd.CommandPath(), cmd.CommandPath())
	}
	if len(args) > 1 {
		return fmt.Errorf("expected 1 argument but received %d", len(args))
	}
	return nil
}

// resolveAndApplyRemoteDefaults resolves a remote source and applies working directory defaults.
// Returns the local path, a cleanup function (nil for local sources), and the original remote URL.
// Exits the process on error.
func resolveAndApplyRemoteDefaults(source string) (localPath string, cleanup func(), remoteURL string) {
	localPath, cleanup, remoteURL, err := resolveRemoteSource(source)
	if err != nil {
		slog.Error("Failed to fetch remote runbook", "error", err)
		os.Exit(1)
	}
	if cleanup != nil && workingDir == "" && !workingDirTmp {
		workingDirTmp = true
	}
	return localPath, cleanup, remoteURL
}

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

	localPath, cleanup, err = fetchRemoteRunbook(parsed)
	if err != nil {
		return "", nil, "", err
	}
	return localPath, cleanup, source, nil
}

// fetchRemoteRunbook downloads a runbook from a remote source to a temp directory.
func fetchRemoteRunbook(parsed *api.ParsedRemoteSource) (string, func(), error) {
	if err := requireGit(); err != nil {
		return "", nil, err
	}

	// Resolve the remote ref
	token := api.GetTokenForHost(parsed.Host)
	if err := parsed.Resolve(token); err != nil {
		return "", nil, err
	}

	// Create a temp directory to clone the repo to
	tempDir, err := os.MkdirTemp("", "runbook-remote-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	cleanup := func() { os.RemoveAll(tempDir) }

	success := false
	defer func() {
		if !success {
			cleanup()
		}
	}()

	fmt.Fprintf(os.Stderr, "Downloading runbook from %s/%s/%s...\n", parsed.Host, parsed.Owner, parsed.Repo)

	// Clone the repo
	cloneURL := api.InjectGitHubToken(parsed.CloneURL, token)
	if err := cloneRepo(parsed, cloneURL, tempDir, token); err != nil {
		return "", nil, err
	}

	// Make sure the directory contains a runbook.mdx
	runbookDir, err := validateRunbookInDir(tempDir, parsed)
	if err != nil {
		return "", nil, err
	}

	fmt.Fprintf(os.Stderr, "Runbook downloaded successfully.\n")

	success = true
	return runbookDir, cleanup, nil
}

// requireGit returns an error if git is not available on PATH.
func requireGit() error {
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("git is required to download remote runbooks but was not found on PATH")
	}
	return nil
}

// cloneRepo performs a git clone (sparse or full) into tempDir with a 2-minute timeout.
func cloneRepo(parsed *api.ParsedRemoteSource, cloneURL, tempDir, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var output []byte
	var cloneErr error

	if parsed.Path != "" {
		slog.Info("Sparse cloning remote runbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref, "path", parsed.Path)
		output, cloneErr = api.GitSparseCloneSimple(ctx, cloneURL, tempDir, parsed.Path, parsed.Ref)
	} else {
		slog.Info("Cloning remote runbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref)
		output, cloneErr = api.GitCloneSimple(ctx, cloneURL, tempDir, parsed.Ref)
	}

	if cloneErr != nil {
		return classifyCloneError(cloneErr, output, token, parsed)
	}
	return nil
}

// validateRunbookInDir locates the runbook directory within the cloned repo,
// verifies it contains a runbook.mdx, and warns if the clone is large.
func validateRunbookInDir(tempDir string, parsed *api.ParsedRemoteSource) (string, error) {
	runbookDir := tempDir
	if parsed.Path != "" {
		runbookDir = filepath.Join(tempDir, parsed.Path)
	}

	resolvedPath, err := api.ResolveRunbookPath(runbookDir)
	if err != nil {
		pathDesc := parsed.Path
		if pathDesc == "" {
			pathDesc = "(repo root)"
		}
		return "", fmt.Errorf("no runbook found at the specified path — expected runbook.mdx in %s", pathDesc)
	}

	warnIfLarge(tempDir)
	slog.Info("Remote runbook resolved", "path", resolvedPath)

	return runbookDir, nil
}

// classifyCloneError examines a git clone error and returns a user-friendly message.
func classifyCloneError(cloneErr error, output []byte, token string, parsed *api.ParsedRemoteSource) error {
	errMsg := cloneErr.Error()
	if output != nil {
		errMsg = string(output) + " " + errMsg
	}
	sanitized := api.SanitizeGitError(errMsg)

	if isAuthError(sanitized) {
		tokenVar, cliCmd := authHintForHost(parsed.Host)
		if token == "" {
			return fmt.Errorf("authentication required for %s/%s/%s: set %s, or run '%s'",
				parsed.Host, parsed.Owner, parsed.Repo, tokenVar, cliCmd)
		}
		return fmt.Errorf("authentication failed for %s/%s/%s (token may be invalid or expired): verify %s, or re-run '%s'",
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
