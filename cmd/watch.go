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

var disableLiveFileReload bool

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch RUNBOOK_SOURCE",
	Short: "Open a runbook and auto-reload changes (for runbook authors)",
	Long: `Open the runbook located at RUNBOOK_SOURCE, or the runbook contained in the RUNBOOK_SOURCE directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.
By default, script changes take effect immediately without server restart (live-file-reload mode).

RUNBOOK_SOURCE can be a local path or a remote URL. See 'runbooks open --help' for supported remote formats.

This command is intended for runbook authors and will be less useful for runbook consumers.`,
	GroupID: "main",
	Args: validateSourceArg,
	Run: func(cmd *cobra.Command, args []string) {
		// Track command usage
		telemetry.TrackCommand("watch")

		watchRunbook(args[0])
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	watchCmd.Flags().BoolVar(&disableLiveFileReload, "disable-live-file-reload", false,
		"Enable executable registry validation (requires server restart for script changes)")
}

// watchRunbook opens a runbook with file watching enabled
func watchRunbook(source string) {
	rb := resolveRunbook(source)
	defer rb.Close()

	useExecutableRegistry := disableLiveFileReload
	slog.Info("Opening runbook with file watching", "path", rb.Path, "workingDir", rb.WorkDir, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

	startServerAndLaunch(rb, func() error {
		return api.StartServer(api.ServerConfig{
			RunbookPath:           rb.Path,
			Port:                  defaultPort,
			WorkingDir:            rb.WorkDir,
			OutputPath:            outputPath,
			RemoteSourceURL:       rb.RemoteURL,
			UseExecutableRegistry: useExecutableRegistry,
			IsWatchMode:           true,
		})
	})
}
