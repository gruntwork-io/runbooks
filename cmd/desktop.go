package cmd

import (
	"log/slog"
	"os"

	"github.com/gruntwork-io/runbooks/desktop"

	"github.com/spf13/cobra"
)

// desktopCmd boots the Wails v3 window that hosts the Gruntbooks UI.
// M1 scope: renders the embedded React bundle with no backend services
// wired in. Later milestones add the Wails services and IPC bindings,
// at which point this subcommand becomes the default entry point for
// `gruntbooks open`.
var desktopCmd = &cobra.Command{
	Use:     "desktop",
	Short:   "Launch the Gruntbooks desktop window (Wails v3, preview)",
	Long:    `Launch the Gruntbooks desktop window rendered by Wails v3. Preview only — backend services are not yet wired in.`,
	GroupID: "other",
	Hidden:  true,
	Run: func(cmd *cobra.Command, args []string) {
		err := desktop.Run(desktop.Options{
			Title:  "Gruntbooks",
			Width:  1280,
			Height: 800,
		})
		if err != nil {
			slog.Error("Desktop window exited with error", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(desktopCmd)
}
