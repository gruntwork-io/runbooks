package cmd

import (
	"log/slog"
	"os"

	"github.com/gruntwork-io/runbooks/desktop"

	"github.com/spf13/cobra"
)

// desktopCmd boots the Wails v3 window that hosts the Gruntbooks UI.
// M2 scope: Welcome screen drives gruntbook selection via the
// WelcomeService IPC methods; an optional PATH argument skips Welcome
// and opens the specified gruntbook directly (Welcome records it in
// its recent list). Hidden because users still drive this through
// `gruntbooks open`/`watch` until M5 rewires those as launchers.
var desktopCmd = &cobra.Command{
	Use:     "desktop [GRUNTBOOK_PATH]",
	Short:   "Launch the Gruntbooks desktop window (Wails v3, preview)",
	Long:    `Launch the Gruntbooks desktop window rendered by Wails v3. With no argument, opens the Welcome screen so the user can pick a gruntbook. Preview only — most backend services are still served over HTTP.`,
	GroupID: "other",
	Hidden:  true,
	Args:    cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var initialPath string
		if len(args) == 1 {
			initialPath = args[0]
		}

		err := desktop.Run(desktop.Options{
			Title:       "Gruntbooks",
			Width:       1280,
			Height:      800,
			InitialPath: initialPath,
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
