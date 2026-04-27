package cmd

import (
	"log/slog"
	"os"

	"github.com/gruntwork-io/runbooks/desktop"

	"github.com/spf13/cobra"
)

var desktopAuthorMode bool

// desktopCmd boots the Wails v3 window that hosts the Gruntbooks UI.
// Hidden because users drive the desktop through `gruntbooks open` /
// `gruntbooks watch`, which spawn this command as a detached child.
// Surfaced in `--help` would just be confusing — the launcher commands
// are the supported public surface.
var desktopCmd = &cobra.Command{
	Use:     "desktop [GRUNTBOOK_PATH]",
	Short:   "Launch the Gruntbooks desktop window",
	Long:    `Launch the Gruntbooks desktop window. With no argument, opens the Welcome screen so the user can pick a gruntbook. Normally invoked via 'gruntbooks open' / 'gruntbooks watch'.`,
	GroupID: "other",
	Hidden:  true,
	Args:    cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var initialPath string
		if len(args) == 1 {
			initialPath = args[0]
		}

		err := desktop.Run(desktop.Options{
			Title:        "Gruntbooks",
			Width:        1280,
			Height:       800,
			InitialPath:  initialPath,
			IsAuthorMode: desktopAuthorMode,
			Version:      Version,
		})
		if err != nil {
			slog.Error("Desktop window exited with error", "error", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(desktopCmd)

	// --author selects Author Mode at boot. The user can also toggle
	// Author Mode at runtime from the View menu; this flag just sets
	// the initial state.
	desktopCmd.Flags().BoolVar(&desktopAuthorMode, "author", false,
		"Boot with Author Mode enabled (hot-reload on edit, registry panel visible)")
}
