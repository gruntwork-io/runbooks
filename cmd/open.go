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
	Use:   "open RUNBOOK_SOURCE",
	Short: "Open a runbook (for runbook consumers)",
	Long: `Open the runbook at RUNBOOK_SOURCE in your browser.

RUNBOOK_SOURCE can be a local path to a runbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.

Examples:
  runbooks open ./path/to/runbook
  runbooks open https://github.com/org/repo/tree/main/runbooks/rds
  runbooks open github.com/org/repo//modules/rds?ref=v1.0`,
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
