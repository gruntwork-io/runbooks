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
	Use:   "serve RUNBOOK_SOURCE",
	Short: "Start the backend API server (for runbook developers)",
	Long: fmt.Sprintf(`This command will start the backend API server on port %d with the runbook located at RUNBOOK_SOURCE. You can then access
the server at http://localhost:%d.

This command is useful for Runbooks developers; it is of limited value to runbook authors and consumers.

RUNBOOK_SOURCE can be a local path or a remote URL. See 'runbooks open --help' for supported remote formats.
`, defaultPort, defaultPort),
	GroupID: "other",
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("serve")

		rb := resolveRunbook(args[0])
		defer rb.Close()

		slog.Info("Starting backend server", "workingDir", rb.WorkDir, "outputPath", outputPath)

		if err := api.StartServer(api.ServerConfig{
			RunbookPath:           rb.Path,
			Port:                  defaultPort,
			WorkingDir:            rb.WorkDir,
			OutputPath:            outputPath,
			RemoteSourceURL:       rb.RemoteURL,
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
