package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// versionCmd represents the version command
var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version information",
	Long:  `Display version information including version number, git commit, and build date.`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Runbooks %s (Commit: %s)\n", Version, GitCommit)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}