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

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:     "open PATH",
	Short:   "Open a runbook (for runbook consumers)",
	Long:    `Open the runbook located at PATH, or the runbook contained in the PATH directory.`,
	GroupID: "main",
	Run: func(cmd *cobra.Command, args []string) {
		telemetry.TrackCommand("open")

		rb := resolveForServer(args)
		if rb.cleanup != nil {
			defer rb.cleanup()
		}

		slog.Info("Opening runbook", "path", rb.serverPath, "workingDir", rb.workingDir, "outputPath", outputPath)

		errCh := make(chan error, 1)
		go func() {
			errCh <- api.StartServer(api.ServerConfig{
				RunbookPath:           rb.serverPath,
				Port:                  7825,
				WorkingDir:            rb.workingDir,
				OutputPath:            outputPath,
				RemoteSourceURL:       rb.remoteSourceURL,
				UseExecutableRegistry: true,
				ReleaseMode:           true,
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
	rootCmd.AddCommand(openCmd)
}
