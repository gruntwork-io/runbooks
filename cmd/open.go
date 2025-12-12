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

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:   "open PATH",
	Short: "Open a runbook",
	Long:  `Open the runbook located at PATH, or the runbook contained in the PATH directory.`,
	Run: func(cmd *cobra.Command, args []string) {
		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		openRunbook(path)
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}

// openRunbook opens a runbook by starting the API server and opening the browser
func openRunbook(path string) {
	slog.Info("Opening runbook", "path", path, "outputPath", outputPath)

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server in a goroutine
	go func() {
		errCh <- api.StartServer(path, 7825, outputPath)
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
