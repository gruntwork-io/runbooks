/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"os"

	"runbooks/api"
	"runbooks/api/telemetry"
	"runbooks/browser"

	"github.com/spf13/cobra"
)

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:     "open <Runbook Source>",
	Short:   "Open a runbook (for runbook consumers)",
	Long: `Open the runbook located at SOURCE, or the runbook contained in the <Runbook Source> directory.

<Runbook Source> can be a local path or a remote URL:
  runbooks open ./path/to/runbook
  runbooks open https://github.com/org/repo/tree/main/runbooks/setup-vpc
  runbooks open github.com/org/repo//runbooks/setup-vpc?ref=v1.0
  runbooks open "git::https://github.com/org/repo.git//runbooks/setup-vpc?ref=main"

Supported remote formats:
  - GitHub/GitLab browser URLs (tree or blob)
  - OpenTofu-style github.com/owner/repo//path?ref=tag
  - OpenTofu-style git::https://host/owner/repo.git//path?ref=tag`,
	GroupID: "main",
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("open")

		openRunbook(args[0])
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}

// openRunbook opens a runbook by starting the API server and opening the browser
func openRunbook(path string) {
	// Check if path is a remote source (GitHub/GitLab URL, OpenTofu source, etc.)
	path, remoteCleanup, remoteURL := resolveAndApplyRemoteDefaults(path)
	if remoteCleanup != nil {
		defer remoteCleanup()
	}

	// Resolve the working directory
	resolvedWorkDir, cleanup, err := resolveWorkingDir(workingDir, workingDirTmp)
	if err != nil {
		slog.Error("Failed to resolve working directory", "error", err)
		os.Exit(1)
	}
	if cleanup != nil {
		defer cleanup()
	}

	slog.Info("Opening runbook", "path", path, "workingDir", resolvedWorkDir, "outputPath", outputPath)

	// Resolve the runbook path before starting the server
	// This is needed to verify we're connecting to the correct server instance
	resolvedPath, err := api.ResolveRunbookPath(path)
	if err != nil {
		slog.Error("Failed to resolve runbook path", "error", err)
		os.Exit(1)
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server in a goroutine
	go func() {
		errCh <- api.StartServer(path, defaultPort, resolvedWorkDir, outputPath, remoteURL)
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(defaultPort)
}
