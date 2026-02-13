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

	// Resolve the runbook path before starting the server
	// This is needed to verify we're connecting to the correct server instance
	resolvedPath, err := api.ResolveRunbookPath(path)
	if err != nil {
		// If no runbook found, check if this is an OpenTofu module
		if api.IsTofuModule(path) {
			slog.Info("Detected OpenTofu module, generating runbook", "path", path)
			generatedPath, tofuCleanup, genErr := api.GenerateRunbook(path, "" /* default template */)
			if genErr != nil {
				slog.Error("Failed to generate runbook from OpenTofu module", "error", genErr)
				os.Exit(1)
			}
			if tofuCleanup != nil {
				defer tofuCleanup()
			}
			resolvedPath = generatedPath
			// Update path to the generated runbook directory for the server
			path = generatedPath
		} else {
			slog.Error("No runbook or OpenTofu module found", "path", path, "error", err)
			os.Exit(1)
		}
	}

	// Channel to receive server startup errors
	errCh := make(chan error, 1)

	// Start the API server in a goroutine
	go func() {
		errCh <- api.StartServer(path, 7825, resolvedWorkDir, outputPath)
	}()

	// Wait for the server to be ready by polling the health endpoint
	if err := waitForServerReady(defaultPort, resolvedPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
