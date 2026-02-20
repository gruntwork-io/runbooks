/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"log/slog"

	"runbooks/api"
	"runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:     "open PATH",
	Short:   "Open a runbook (for runbook consumers)",
	Long:    `Open the runbook located at PATH, or the runbook contained in the PATH directory.`,
	GroupID: "main",
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("open")

		rb := resolveForServer(args)
		if rb.cleanup != nil {
			defer rb.cleanup()
		}

		slog.Info("Opening runbook", "path", rb.serverPath, "workingDir", rb.workingDir, "outputPath", outputPath)

		startServerAndOpen(rb, api.ServerConfig{
			RunbookPath:           rb.serverPath,
			Port:                  defaultPort,
			WorkingDir:            rb.workingDir,
			OutputPath:            outputPath,
			RemoteSourceURL:       rb.remoteSourceURL,
			UseExecutableRegistry: true,
			ReleaseMode:           true,
		})
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}
