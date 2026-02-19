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
	Use:     "open PATH",
	Short:   "Open a runbook (for runbook consumers)",
	Long:    `Open the runbook located at PATH, or the runbook contained in the PATH directory.`,
	GroupID: "main",
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("open")

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

	// Resolve the runbook path (or generate from OpenTofu module)
	resolvedPath, path, tofuCleanup := resolveRunbookOrTofuModule(path)
	if tofuCleanup != nil {
		defer tofuCleanup()
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server in a goroutine
	go func() {
		errCh <- api.StartServer(api.ServerConfig{
			RunbookPath:           path,
			Port:                  7825,
			WorkingDir:            resolvedWorkDir,
			OutputPath:            outputPath,
			UseExecutableRegistry: true,
			ReleaseMode:           true,
		})
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
