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

	"github.com/spf13/cobra"
)

// serveCmd represents the serve command
var serveCmd = &cobra.Command{
	Use:   "serve SOURCE",
	Short: "Start the backend API server (for runbook developers)",
	Long: `This command will start the backend API server on port 7825. You can then access
the server at http://localhost:7825.

This is useful for local development on the runbooks tool. Runbook authors and consumers will not find this useful.

SOURCE can be a local path or a remote URL. See 'runbooks open --help' for supported remote formats.
`,
	GroupID: "other",
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("serve")

		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		// Check if path is a remote source
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

		slog.Info("Starting backend server", "workingDir", resolvedWorkDir, "outputPath", outputPath)

		if err := api.StartBackendServer(path, 7825, resolvedWorkDir, outputPath, remoteURL); err != nil {
			slog.Error("Failed to start backend server", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}
