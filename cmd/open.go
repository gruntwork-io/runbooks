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

	// Here you will define your flags and configuration settings.

	// Cobra supports Persistent Flags which will work for this command
	// and all subcommands, e.g.:
	// openCmd.PersistentFlags().String("foo", "", "A help for foo")

	// Cobra supports local flags which will only run when this command
	// is called directly, e.g.:
	// openCmd.Flags().BoolP("toggle", "t", false, "Help message for toggle")
}

// openRunbook opens a runbook by starting the API server and opening the browser
func openRunbook(path string) {
	slog.Info("Opening runbook", "path", path)

	// Start the API server in a goroutine
	go func() {
		api.StartServer(path, 7825)
	}()

	// Open browser and keep server running
	browser.LaunchAndWait(7825)
}
