/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"os"

	"runbooks/api"

	"github.com/spf13/cobra"
)

// serveCmd represents the serve command
var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the backend API server",
	Long: `This command will start the backend API server on port 7825. You can then access 
the server at http://localhost:7825.

This is useful for local development on the runbooks tool. Runbook authors and consumers will not find this useful.
`,
	Run: func(cmd *cobra.Command, args []string) {
		if len(args) == 0 {
			slog.Error("Error: You must specify a path to a runbook file or directory\n")
			fmt.Fprintf(os.Stderr, "")
			os.Exit(1)
		}
		path := args[0]

		// TODO: Handle this goroutine properly, catching failure, etc.
		api.StartBackendServer(path, 7825)
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)

	// Here you will define your flags and configuration settings.

	// Cobra supports Persistent Flags which will work for this command
	// and all subcommands, e.g.:
	// openCmd.PersistentFlags().String("foo", "", "A help for foo")

	// Cobra supports local flags which will only run when this command
	// is called directly, e.g.:
	// openCmd.Flags().BoolP("toggle", "t", false, "Help message for toggle")
}
