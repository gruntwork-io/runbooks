/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"runbooks/api"
	"runbooks/browser"

	"github.com/spf13/cobra"
)

var disableLiveFileReload bool

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch PATH",
	Short: "Open a runbook and automatically reload on changes",
	Long: `Open the runbook located at PATH, or the runbook contained in the PATH directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.
By default, script changes take effect immediately without server restart (live-file-reload mode).`,
	Run: func(cmd *cobra.Command, args []string) {
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
	// By default, watch mode uses live-file-reload (no registry) for better UX
	// If --disable-live-file-reload is true, use the executable registry for better security
	useExecutableRegistry := disableLiveFileReload
	slog.Info("Opening runbook with file watching", "path", path, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server with watching in a goroutine
	go func() {
		errCh <- api.StartServerWithWatch(path, 7825, outputPath, useExecutableRegistry)
	}()

	// Give the server a moment to bind the port before launching browser
	select {
	case err := <-errCh:
		// Server exited immediately (likely port in use or other startup error)
		slog.Error("Failed to start server", "error", err)
		fmt.Fprintln(os.Stderr, "Hint: Is another instance of runbooks already running on port 7825?")
		os.Exit(1)
	case <-time.After(100 * time.Millisecond):
		// Server seems to have started successfully, continue
	}

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
