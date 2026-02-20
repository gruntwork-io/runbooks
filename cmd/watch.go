/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"os"

	"runbooks/api"
	"runbooks/api/telemetry"
	"runbooks/browser"

	"github.com/spf13/cobra"
)

var disableLiveFileReload bool

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch PATH",
	Short: "Open a runbook and auto-reload changes (for runbook authors)",
	Long: `Open the runbook located at PATH, or the runbook contained in the PATH directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.
By default, script changes take effect immediately without server restart (live-file-reload mode).`,
	GroupID: "main",
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("watch")

		rb := resolveForServer(args)
		if rb.cleanup != nil {
			defer rb.cleanup()
		}

		// By default, watch mode uses live-file-reload (no registry) for better UX.
		// If --disable-live-file-reload is true, use the executable registry for better security.
		useExecutableRegistry := disableLiveFileReload
		slog.Info("Opening runbook with file watching", "path", rb.serverPath, "workingDir", rb.workingDir, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

		errCh := make(chan error, 1)
		go func() {
			errCh <- api.StartServer(api.ServerConfig{
				RunbookPath:           rb.serverPath,
				Port:                  7825,
				WorkingDir:            rb.workingDir,
				OutputPath:            outputPath,
				RemoteSourceURL:       rb.remoteSourceURL,
				IsWatchMode:           true,
				UseExecutableRegistry: useExecutableRegistry,
			})
		}()

		if err := waitForServerReady(defaultPort, rb.runbookPath, errCh); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		browser.LaunchAndWait(7825)
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	watchCmd.Flags().BoolVar(&disableLiveFileReload, "disable-live-file-reload", false,
		"Enable executable registry validation (requires server restart for script changes)")
}
