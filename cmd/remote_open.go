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

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"

	"github.com/spf13/cobra"
)

// cmdTokenResolver returns a TokenResolver backed by the host process's
// real environment and process spawner. CLI commands that download
// remote sources use this to authenticate against private git hosts.
//
// A new resolver is created per call so the per-resolver CLI cache
// doesn't outlive the command. Commands that make many lookups in one
// invocation should hold the returned resolver instead of calling this
// repeatedly.
func cmdTokenResolver() *api.TokenResolver {
	return api.NewTokenResolver(adapters.NewOsEnvironment(), adapters.NewOsProcessSpawner())
}

// validateSourceArg is a Cobra Args validator that provides a clear error when GRUNTBOOK_SOURCE is missing.
func validateSourceArg(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("missing required argument: GRUNTBOOK_SOURCE\n\nProvide a local path or remote URL to a gruntbook:\n  %s /path/to/gruntbook\n  %s https://github.com/org/repo/tree/main/gruntbooks/my-gruntbook\n", cmd.CommandPath(), cmd.CommandPath())
	}
	if len(args) > 1 {
		return fmt.Errorf("expected 1 argument but received %d", len(args))
	}
	return nil
}

// resolveRemoteSource checks if the given source is a remote URL.
// If so, downloads the gruntbook to a temp directory and returns the local path + cleanup func + original remote URL.
// If not a remote source, returns the original path unchanged with nil cleanup and empty remoteURL.
func resolveRemoteSource(source string, git ports.GitClient) (localPath string, cleanup func(), isRemote bool, remoteURL string, err error) {
	parsed, err := api.ParseRemoteSource(source)
	if err != nil {
		return "", nil, false, "", fmt.Errorf("invalid remote source %q: %w", source, err)
	}
	if parsed == nil {
		return source, nil, false, "", nil
	}

	localPath, cleanup, err = downloadRemoteGruntbook(parsed, git)
	if err != nil {
		return "", nil, false, "", err
	}
	return localPath, cleanup, true, source, nil
}

// downloadRemoteSource downloads a remote source to a temp directory.
// Returns the local path to the target directory (accounting for parsed.Path),
// a cleanup function, and any error. Does NOT validate what's in the directory.
func downloadRemoteSource(parsed *api.ParsedRemoteSource, git ports.GitClient) (string, func(), error) {
	if err := requireGit(); err != nil {
		return "", nil, err
	}

	// Resolve the remote ref
	token := cmdTokenResolver().TokenForHost(parsed.Host)
	if err := parsed.Resolve(token); err != nil {
		return "", nil, err
	}

	// Create a temp directory to clone the repo to
	tempDir, err := os.MkdirTemp("", "gruntbook-remote-*")
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
	if err := cloneRepo(parsed, cloneURL, tempDir, token, git); err != nil {
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

// downloadRemoteGruntbook downloads a gruntbook from a remote source to a temp directory.
func downloadRemoteGruntbook(parsed *api.ParsedRemoteSource, git ports.GitClient) (string, func(), error) {
	targetDir, cleanup, err := downloadRemoteSource(parsed, git)
	if err != nil {
		return "", nil, err
	}

	// Make sure the directory contains a gruntbook.mdx (or legacy runbook.mdx)
	_, rbErr := api.ResolveGruntbookPath(targetDir)
	if rbErr != nil {
		if cleanup != nil {
			cleanup()
		}
		pathDesc := parsed.Path
		if pathDesc == "" {
			pathDesc = "(repo root)"
		}
		return "", nil, fmt.Errorf("no gruntbook found at the specified path — expected gruntbook.mdx in %s", pathDesc)
	}

	fmt.Fprintf(os.Stderr, "Gruntbook downloaded successfully.\n")
	return targetDir, cleanup, nil
}

// requireGit returns an error if git is not available on PATH.
func requireGit() error {
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("git is required to download remote gruntbooks but was not found on PATH")
	}
	return nil
}

// cloneRepo performs a git clone (sparse or full) into tempDir with a 2-minute timeout.
func cloneRepo(parsed *api.ParsedRemoteSource, cloneURL, tempDir, token string, git ports.GitClient) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if parsed.Path != "" {
		slog.Info("Sparse cloning remote gruntbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref, "path", parsed.Path)
	} else {
		slog.Info("Cloning remote gruntbook", "host", parsed.Host, "owner", parsed.Owner, "repo", parsed.Repo, "ref", parsed.Ref)
	}

	output, cloneErr := git.Clone(ctx, ports.GitCloneRequest{
		URL:      cloneURL,
		DestPath: tempDir,
		Ref:      parsed.Ref,
		RepoPath: parsed.Path,
	})
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

	if !isAuthError(sanitized) {
		return fmt.Errorf("failed to download gruntbook: %s", sanitized)
	}

	repo := fmt.Sprintf("%s/%s/%s", parsed.Host, parsed.Owner, parsed.Repo)
	tokenVar, cliCmd := api.AuthHintForHost(parsed.Host)

	if token == "" {
		// No token provided — tell user how to authenticate
		if tokenVar == "" {
			return fmt.Errorf("authentication required for %s: provide an access token for %s", repo, parsed.Host)
		}
		return fmt.Errorf("authentication required for %s: set %s, or run '%s'", repo, tokenVar, cliCmd)
	}

	// Token was provided but failed
	if tokenVar == "" {
		return fmt.Errorf("authentication failed for %s (token may be invalid or expired)", repo)
	}
	return fmt.Errorf("authentication failed for %s (token may be invalid or expired): verify %s, or re-run '%s'", repo, tokenVar, cliCmd)
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
		fmt.Fprintf(os.Stderr, "Warning: downloaded gruntbook is large (%d MB)\n", totalSize/(1024*1024))
	}
}
