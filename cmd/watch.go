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

var disableLiveFileReload bool

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch SOURCE",
	Short: "Open a runbook and auto-reload changes (for runbook authors)",
	Long: `Open the runbook located at SOURCE, or the runbook contained in the SOURCE directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.
By default, script changes take effect immediately without server restart (live-file-reload mode).

SOURCE can be a local path or a remote URL. See 'runbooks open --help' for supported remote formats.`,
	GroupID: "main",
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("watch")

		watchRunbook(args[0])
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	watchCmd.Flags().BoolVar(&disableLiveFileReload, "disable-live-file-reload", false,
		"Enable executable registry validation (requires server restart for script changes)")
}

// watchRunbook opens a runbook with file watching enabled
func watchRunbook(path string) {
	// Check if path is a remote source (GitHub/GitLab URL, OpenTofu source, etc.)
	localPath, remoteCleanup, remoteURL, err := resolveSource(path)
	if err != nil {
		slog.Error("Failed to resolve runbook source", "error", err)
		os.Exit(1)
	}
	if remoteCleanup != nil {
		defer remoteCleanup()
		// Remote runbooks have no meaningful local directory for a working dir
		if workingDir == "" && !workingDirTmp {
			workingDirTmp = true
		}
	}

	runbook := api.ResolvedRunbook{LocalPath: localPath, RemoteSourceURL: remoteURL}

	// Resolve the working directory
	resolvedWorkDir, cleanup, err := resolveWorkingDir(workingDir, workingDirTmp)
	if err != nil {
		slog.Error("Failed to resolve working directory", "error", err)
		os.Exit(1)
	}
	if cleanup != nil {
		defer cleanup()
	}

	// By default, watch mode uses live-file-reload (no registry) for better UX
	// If --disable-live-file-reload is true, use the executable registry for better security
	useExecutableRegistry := disableLiveFileReload
	slog.Info("Opening runbook with file watching", "path", localPath, "workingDir", resolvedWorkDir, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

	// Resolve the runbook path before starting the server
	// This is needed to verify we're connecting to the correct server instance
	resolvedPath, err := api.ResolveRunbookPath(localPath)
	if err != nil {
		slog.Error("Failed to resolve runbook path", "error", err)
		os.Exit(1)
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server with watching in a goroutine
	go func() {
		errCh <- api.StartServerWithWatch(runbook, defaultPort, resolvedWorkDir, outputPath, useExecutableRegistry)
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(defaultPort)
}
