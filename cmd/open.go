/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"runtime"

	"github.com/gin-gonic/gin"
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

func openRunbook(path string) {
	slog.Info("Opening runbook", "path", path)

	// Start web server in a goroutine
	// TODO: Handle this goroutine properly, catching failure, etc.
	go startHttpServer()

	// Wait a moment for the server to start
	// TODO: Enable this in production only
	//time.Sleep(250 * time.Millisecond)

	// Open browser to localhost:7825
	err := openBrowser("http://localhost:7825")
	if err != nil {
		slog.Warn("Failed to open browser", "error", err)
		slog.Info("Manual browser access", "url", "http://localhost:7825")
	}

	// Keep the main thread alive so the web server continues running
	slog.Info("Web server started", "url", "http://localhost:7825")
	fmt.Println("Press Ctrl+C to stop the server")

	// Wait indefinitely to keep the server running
	select {}
}

func startHttpServer() {
	// TODO: Update gin to run in release mode (not debug mode, except by flag)
	// TODO: Deal with this issue:
	// [GIN-debug] [WARNING] You trusted all proxies, this is NOT safe. We recommend you to set a value.
	// Please check https://pkg.go.dev/github.com/gin-gonic/gin#readme-don-t-trust-all-proxies for details.
	r := gin.Default()
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "Hello, World!",
		})
	})

	// listen and serve on 0.0.0.0:7825 | localhost:7825
	r.Run(":7825")
}

// openBrowser opens the specified URL in the default browser
func openBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	return cmd.Start()
}
