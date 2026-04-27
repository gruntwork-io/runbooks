package cmd

import (
	"log/slog"
	"os"

	"github.com/gruntwork-io/runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

// openCmd is the canonical user-facing entrypoint into the Gruntbooks
// desktop app for runbook *consumers*. It re-execs the binary as a
// detached `gruntbooks desktop PATH` child and exits, so the terminal
// returns immediately. The desktop SingleInstanceLock collapses repeat
// invocations into the existing window when one is already open.
//
// Author mode (auto-reload on file change, registry panel, parse errors)
// is a separate affordance — `gruntbooks watch` adds --author, or the
// user can toggle it from the View menu inside the running app.
var openCmd = &cobra.Command{
	Use:   "open GRUNTBOOK_SOURCE",
	Short: "Open a gruntbook in the desktop app (for gruntbook consumers)",
	Long: `Open the gruntbook at GRUNTBOOK_SOURCE in the Gruntbooks desktop app.

GRUNTBOOK_SOURCE can be a local path to a gruntbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.

The terminal returns immediately once the desktop window opens. If a
window is already running, the gruntbook opens in the existing app.

Examples:
  gruntbooks open ./path/to/gruntbook
  gruntbooks open https://github.com/org/repo/tree/main/gruntbooks/rds
  gruntbooks open github.com/org/repo//modules/rds?ref=v1.0`,
	GroupID: "main",
	Args:    cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("open")
		if err := spawnDesktop(args[0]); err != nil {
			slog.Error("Failed to launch desktop window", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}
