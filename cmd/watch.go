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

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch PATH",
	Short: "Open a runbook and automatically reload on changes",
	Long: `Open the runbook located at PATH, or the runbook contained in the PATH directory.
The runbook will automatically reload when changes are detected to the underlying runbook.mdx file.`,
	Run: func(cmd *cobra.Command, args []string) {
		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		watchRunbook(path)
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	// Here you will define your flags and configuration settings.

	// Cobra supports Persistent Flags which will work for this command
	// and all subcommands, e.g.:
	// watchCmd.PersistentFlags().String("foo", "", "A help for foo")

	// Cobra supports local flags which will only run when this command
	// is called directly, e.g.:
	// watchCmd.Flags().BoolP("toggle", "t", false, "Help message for toggle")
}

// watchRunbook opens a runbook with file watching enabled
func watchRunbook(path string) {
	slog.Info("Opening runbook with file watching", "path", path)

	// Start the API server with watching in a goroutine
	go func() {
		if err := api.StartServerWithWatch(path, 7825); err != nil {
			slog.Error("Failed to start server with watch", "error", err)
			os.Exit(1)
		}
	}()

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
