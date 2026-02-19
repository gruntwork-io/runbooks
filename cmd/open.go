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
	Use:     "open RUNBOOK_SOURCE",
	Short:   "Open a runbook (for runbook consumers)",
	Long: `Open the runbook located at RUNBOOK_SOURCE, or the runbook contained in the RUNBOOK_SOURCE directory.

RUNBOOK_SOURCE can be a local path or a remote URL:
  runbooks open ./path/to/runbook
  runbooks open https://github.com/org/repo/tree/main/runbooks/setup-vpc
  runbooks open github.com/org/repo//runbooks/setup-vpc?ref=v1.0
  runbooks open "git::https://github.com/org/repo.git//runbooks/setup-vpc?ref=main"

Supported remote formats:
  - GitHub/GitLab browser URLs (tree or blob)
  - OpenTofu-style github.com/owner/repo//path?ref=tag
  - OpenTofu-style git::https://host/owner/repo.git//path?ref=tag`,
	GroupID: "main",
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("open")

		openRunbook(args[0])
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}

// openRunbook opens a runbook by starting the API server and opening the browser
func openRunbook(source string) {
	rb := resolveRunbook(source)
	defer rb.Close()

	slog.Info("Opening runbook", "path", rb.Path, "workingDir", rb.WorkDir, "outputPath", outputPath)

	startServerAndLaunch(rb, func() error {
		return api.StartServer(rb.Path, defaultPort, rb.WorkDir, outputPath, rb.RemoteURL)
	})
}
