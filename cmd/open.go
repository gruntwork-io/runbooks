/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"os"

	"runbooks/api"
	"runbooks/browser"

	"github.com/spf13/cobra"
)

// openCmd represents the open command
var openCmd = &cobra.Command{
	Use:   "open PATH",
	Short: "Open a runbook",
	Long:  `Open the runbook located at PATH, or the runbook contained in the PATH directory.`,
	Run: func(cmd *cobra.Command, args []string) {
		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		openRunbook(path)
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}

// openRunbook opens a runbook by starting the API server and opening the browser
func openRunbook(path string) {
	slog.Info("Opening runbook", "path", path, "outputPath", outputPath)

	// Start the API server in a goroutine
	go func() {
		api.StartServer(path, 7825, outputPath)
	}()

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
