/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
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
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("serve")

		// Check if path is a remote source
		localPath, remoteCleanup, remoteURL, err := resolveSource(args[0])
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

		slog.Info("Starting backend server", "workingDir", resolvedWorkDir, "outputPath", outputPath)

		if err := api.StartBackendServer(runbook, defaultPort, resolvedWorkDir, outputPath); err != nil {
			slog.Error("Failed to start backend server", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}
