/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"log/slog"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/api/telemetry"

	"github.com/spf13/cobra"
)

var disableLiveFileReload bool

// watchCmd represents the watch command
var watchCmd = &cobra.Command{
	Use:   "watch GRUNTBOOK_SOURCE",
	Short: "Open a gruntbook and auto-reload changes (for gruntbook authors)",
	Long: `Open the gruntbook at GRUNTBOOK_SOURCE with live-reloading enabled.

The gruntbook will automatically reload when changes are detected to
the underlying gruntbook.mdx file. By default, script changes take
effect immediately without server restart (live-file-reload mode).

GRUNTBOOK_SOURCE can be a local path to a gruntbook.mdx file or its
containing directory, a remote GitHub/GitLab URL, or an OpenTofu/Terraform
module directory.

Examples:
  gruntbooks watch ./path/to/gruntbook
  gruntbooks watch https://github.com/org/repo/tree/main/gruntbooks/rds`,
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
		slog.Info("Opening gruntbook with file watching", "path", rb.serverPath, "workingDir", rb.workingDir, "outputPath", outputPath, "useExecutableRegistry", useExecutableRegistry)

		startServerAndOpen(rb, api.ServerConfig{
			GruntbookPath:         rb.serverPath,
			Port:                  port,
			WorkingDir:            rb.workingDir,
			OutputPath:            outputPath,
			RemoteSourceURL:       rb.remoteSourceURL,
			IsWatchMode:           true,
			UseExecutableRegistry: useExecutableRegistry,
		})
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)

	watchCmd.Flags().BoolVar(&disableLiveFileReload, "disable-live-file-reload", false,
		"Enable executable registry validation (requires server restart for script changes)")
}
