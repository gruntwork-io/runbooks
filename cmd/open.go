/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"log/slog"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:   "open GRUNTBOOK_SOURCE",
	Short: "Open a gruntbook (for gruntbook consumers)",
	Long: `Open the gruntbook at GRUNTBOOK_SOURCE in your browser.

GRUNTBOOK_SOURCE can be a local path to a gruntbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.

Examples:
  gruntbooks open ./path/to/gruntbook
  gruntbooks open https://github.com/org/repo/tree/main/gruntbooks/rds
  gruntbooks open github.com/org/repo//modules/rds?ref=v1.0`,
	GroupID: "main",
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("open")

		rb := resolveForServer(args)
		if rb.cleanup != nil {
			defer rb.cleanup()
		}

		slog.Info("Opening gruntbook", "path", rb.serverPath, "workingDir", rb.workingDir, "outputPath", outputPath)

		startServerAndOpen(rb, api.ServerConfig{
			GruntbookPath:         rb.serverPath,
			Port:                  port,
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
