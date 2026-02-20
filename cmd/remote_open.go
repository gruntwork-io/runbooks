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

// resolvedRunbook holds the fully resolved configuration for running a runbook.
// Call Close() (typically via defer) to clean up any temporary directories.
type resolvedRunbook struct {
	Path      string // local path to the runbook directory or file
	WorkDir   string // resolved working directory
	RemoteURL string // original remote URL; empty for local sources
	cleanups  []func()
}

// Close runs all cleanup functions in reverse order of acquisition.
func (r *resolvedRunbook) Close() {
	for i := len(r.cleanups) - 1; i >= 0; i-- {
		r.cleanups[i]()
	}
}

// resolveRunbook resolves a runbook source string (local path or remote URL) and
// working directory into a fully resolved configuration. Exits the process on error.
func resolveRunbook(source string) *resolvedRunbook {
	path, pathCleanup, isRemote, remoteURL, err := resolveRemoteSource(source)
	if err != nil {
		slog.Error("Failed to fetch remote runbook", "error", err)
		os.Exit(1)
	}
	useTmpWorkDir := isWorkingDirTmp() || (isRemote && workingDir == "")
	workDir, workDirCleanup, err := resolveWorkingDir(workingDir, useTmpWorkDir)
	if err != nil {
		if pathCleanup != nil {
			pathCleanup()
		}
		slog.Error("Failed to resolve working directory", "error", err)
		os.Exit(1)
	}

	var cleanups []func()
	if workDirCleanup != nil {
		cleanups = append(cleanups, workDirCleanup)
	}
	if pathCleanup != nil {
		cleanups = append(cleanups, pathCleanup)
	}

	return &resolvedRunbook{
		Path:      path,
		WorkDir:   workDir,
		RemoteURL: remoteURL,
		cleanups:  cleanups,
	}
}

// resolveRemoteSource checks if the given source is a remote URL.
// If so, downloads the runbook to a temp directory and returns the local path + cleanup func + original remote URL.
// If not a remote source, returns the original path unchanged with nil cleanup and empty remoteURL.
func resolveRemoteSource(source string) (localPath string, cleanup func(), isRemote bool, remoteURL string, err error) {
	parsed, err := api.ParseRemoteSource(source)
	if err != nil {
		return "", nil, false, "", fmt.Errorf("invalid remote source %q: %w", source, err)
	}
	if parsed == nil {
		return source, nil, false, "", nil
	}

	localPath, cleanup, err = downloadRemoteRunbook(parsed)
	if err != nil {
		return "", nil, false, "", err
	}
	return localPath, cleanup, true, source, nil
}

// downloadRemoteSource downloads a remote source to a temp directory.
// Returns the local path to the target directory (accounting for parsed.Path),
// a cleanup function, and any error. Does NOT validate what's in the directory.
func downloadRemoteSource(parsed *api.ParsedRemoteSource) (string, func(), error) {
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

	fmt.Fprintf(os.Stderr, "Downloading from %s/%s/%s...\n", parsed.Host, parsed.Owner, parsed.Repo)

	// Clone the repo
	cloneURL := api.InjectGitToken(parsed.CloneURL, token)
	if err := cloneRepo(parsed, cloneURL, tempDir, token); err != nil {
		return "", nil, err
	}

	// Resolve the target directory within the clone
	targetDir := tempDir
	if parsed.Path != "" {
		if err := api.ValidateRelativePath(parsed.Path); err != nil {
			return "", nil, fmt.Errorf("invalid path in remote source: %w", err)
		}
		targetDir = filepath.Join(tempDir, parsed.Path)
	}

	warnIfLarge(tempDir)

	success = true
	return targetDir, cleanup, nil
}

// downloadRemoteRunbook downloads a runbook from a remote source to a temp directory.
func downloadRemoteRunbook(parsed *api.ParsedRemoteSource) (string, func(), error) {
	targetDir, cleanup, err := downloadRemoteSource(parsed)
	if err != nil {
		return "", nil, err
	}

	// Make sure the directory contains a runbook.mdx
	_, rbErr := api.ResolveRunbookPath(targetDir)
	if rbErr != nil {
		if cleanup != nil {
			cleanup()
		}
		pathDesc := parsed.Path
		if pathDesc == "" {
			pathDesc = "(repo root)"
		}
		return "", nil, fmt.Errorf("no runbook found at the specified path — expected runbook.mdx in %s", pathDesc)
	}

	fmt.Fprintf(os.Stderr, "Runbook downloaded successfully.\n")
	return targetDir, cleanup, nil
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

// classifyCloneError examines a git clone error and returns a user-friendly message.
func classifyCloneError(cloneErr error, output []byte, token string, parsed *api.ParsedRemoteSource) error {
	errMsg := cloneErr.Error()
	if output != nil {
		errMsg = string(output) + " " + errMsg
	}
	sanitized := api.SanitizeGitError(errMsg)

	if isAuthError(sanitized) {
		tokenVar, cliCmd := api.AuthHintForHost(parsed.Host)
		if tokenVar == "" {
			if token == "" {
				return fmt.Errorf("authentication required for %s/%s/%s: provide an access token for %s",
					parsed.Host, parsed.Owner, parsed.Repo, parsed.Host)
			}
			return fmt.Errorf("authentication failed for %s/%s/%s (token may be invalid or expired)",
				parsed.Host, parsed.Owner, parsed.Repo)
		}
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
