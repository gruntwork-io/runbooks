package cmd

import (
	"fmt"
	"os"

	"runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

var (
	// These variables are set via ldflags during build
	Version   = "dev"
	GitCommit = "none"
	BuildDate = "unknown"

	// Global flag for output path used by server commands
	outputPath string

	// Global flag to disable telemetry
	noTelemetry bool
)

// getVersionString returns the full version information
func getVersionString() string {
	return fmt.Sprintf("%s (Commit: %s)", Version, GitCommit)
}

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:     "runbooks",
	Short:   "Make the knowledge and experience of the few available to the many.",
	Long:    `Runbooks makes it easy for subject matter experts to capture their knowledge, and easy for others to consume it.`,
	Version: getVersionString(),
	// PersistentPreRun is a Cobra lifecycle hook that runs BEFORE the Run function
	// of any subcommand (open, watch, serve, etc.). It's inherited by all subcommands,
	// making it ideal for global initialization like telemetry.
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		// Initialize telemetry with version and flag status
		telemetry.Init(Version, noTelemetry)

		// Print telemetry notice (only if enabled)
		// Skip for version and help commands to keep output clean
		if cmd.Name() != "version" && cmd.Name() != "help" && cmd.Name() != "runbooks" {
			telemetry.PrintNotice()
		}
	},
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		os.Exit(1)
	}
}

func init() {
	// Here you will define your flags and configuration settings.
	// Cobra supports:
	// - persistent flags: if defined here, will be global for your application.
	// - local flags: will only run when this action is called directly.

	// Add command groups for organized help output
	rootCmd.AddGroup(&cobra.Group{ID: "main", Title: "Main Commands:"})
	rootCmd.AddGroup(&cobra.Group{ID: "other", Title: "All Other Commands:"})

	// Add persistent flags that are available to all subcommands
	rootCmd.PersistentFlags().StringVar(&outputPath, "output-path", "generated",
		"Path where generated files will be rendered (can be relative or absolute)")

	// Add telemetry opt-out flag
	rootCmd.PersistentFlags().BoolVar(&noTelemetry, "no-telemetry", false,
		"Disable anonymous telemetry (can also set RUNBOOKS_TELEMETRY_DISABLE=1)")

	// Hide the completion command from help
	rootCmd.CompletionOptions.HiddenDefaultCmd = true

	// Hide the help subcommand from help
	rootCmd.SetHelpCommand(&cobra.Command{Hidden: true})
}
