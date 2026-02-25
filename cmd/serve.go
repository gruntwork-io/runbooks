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
	Use:   "serve RUNBOOK_SOURCE",
	Short: "Start the backend API server (for runbook developers)",
	Long: `Start the backend API server for RUNBOOK_SOURCE on port 7825.

This is useful for local development on the Runbooks tool itself.
Runbook authors and consumers should use 'open' or 'watch' instead.

RUNBOOK_SOURCE can be a local path to a runbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.`,
	GroupID: "other",
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("serve")

		rb := resolveForServer(args)
		if rb.cleanup != nil {
			defer rb.cleanup()
		}

		slog.Info("Starting backend server", "workingDir", rb.workingDir, "outputPath", outputPath)

		if err := api.StartServer(api.ServerConfig{
			RunbookPath:           rb.serverPath,
			Port:                  7825,
			WorkingDir:            rb.workingDir,
			OutputPath:            outputPath,
			RemoteSourceURL:       rb.remoteSourceURL,
			UseExecutableRegistry: true,
			EnableCORS:            true,
		}); err != nil {
			slog.Error("Failed to start backend server", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}
