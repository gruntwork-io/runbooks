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
	Use:   "watch PATH",
	Short: "Open a runbook and auto-reload changes (for runbook authors)",
	Long: `Open the runbook located at PATH, or the runbook contained in the PATH directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.
By default, script changes take effect immediately without server restart (live-file-reload mode).`,
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

	// Resolve the runbook path (or generate from OpenTofu module)
	resolvedPath, path, tofuCleanup := resolveRunbookOrTofuModule(path)
	if tofuCleanup != nil {
		defer tofuCleanup()
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server with watching in a goroutine
	go func() {
		errCh <- api.StartServerWithWatch(path, 7825, resolvedWorkDir, outputPath, useExecutableRegistry)
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
