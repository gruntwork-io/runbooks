package cmd

import (
	"log/slog"
	"os"

	"github.com/gruntwork-io/runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

// watchCmd is the gruntbook *author* entrypoint: same launcher as `open`
// but passes --author so the desktop boots with Author Mode enabled
// (auto-reload on edit, registry panel visible, parse errors surfaced,
// no drift warnings). Author Mode can also be toggled at runtime from
// the View menu — `watch` is a convenience for users who already know
// they're editing.
var watchCmd = &cobra.Command{
	Use:   "watch GRUNTBOOK_SOURCE",
	Short: "Open a gruntbook with Author Mode enabled (for gruntbook authors)",
	Long: `Open the gruntbook at GRUNTBOOK_SOURCE in the Gruntbooks desktop app
with Author Mode enabled. Author Mode hot-reloads on every save instead
of showing the consumer-mode drift warning, and exposes block IDs, MDX
parse errors, and the executable registry panel.

GRUNTBOOK_SOURCE can be a local path to a gruntbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.

Examples:
  gruntbooks watch ./path/to/gruntbook
  gruntbooks watch https://github.com/org/repo/tree/main/gruntbooks/rds`,
	GroupID: "main",
	Args:    cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("watch")
		if err := spawnDesktop(args[0], "--author"); err != nil {
			slog.Error("Failed to launch desktop window", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)
}
