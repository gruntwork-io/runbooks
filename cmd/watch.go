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
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("watch")

		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		watchRunbook(path)
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	watchCmd.Flags().BoolVar(&disableLiveFileReload, "disable-live-file-reload", false,
		"Enable executable registry validation (requires server restart for script changes)")
}

// watchRunbook opens a runbook with file watching enabled
func watchRunbook(path string) {
	// Check if path is a remote source (GitHub/GitLab URL, Terraform source, etc.)
	localPath, remoteCleanup, remoteURL, err := resolveRemoteSource(path)
	if err != nil {
		slog.Error("Failed to fetch remote runbook", "error", err)
		os.Exit(1)
	}
	if remoteCleanup != nil {
		defer remoteCleanup()
		if workingDir == "" && !workingDirTmp {
			workingDirTmp = true
		}
	}
	path = localPath

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
	slog.Info("Opening runbook with file watching", "path", path, "workingDir", resolvedWorkDir, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

	// Resolve the runbook path before starting the server
	// This is needed to verify we're connecting to the correct server instance
	resolvedPath, err := api.ResolveRunbookPath(path)
	if err != nil {
		slog.Error("Failed to resolve runbook path", "error", err)
		os.Exit(1)
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server with watching in a goroutine
	go func() {
		errCh <- api.StartServerWithWatch(path, 7825, resolvedWorkDir, outputPath, useExecutableRegistry, remoteURL)
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
