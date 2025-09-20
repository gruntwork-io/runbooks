/*
Copyright © 2025 NAME HERE <EMAIL ADDRESS>
*/
package cmd

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/gin-contrib/cors"
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
	apiServerPort := 7825
	go startApiServer(path, apiServerPort)

	// TODO: Start frontend server
	// Right now I manually run `yarn dev` in the http directory to launch vite
	// For the runbooks consumer, they should run a single command and get the server and api all on the same port

	// TODO: Enable this in production only
	// Wait a moment for the server to start
	//time.Sleep(250 * time.Millisecond)

	// Open browser and keep server running
	browserPort := 5173
	openBrowserAndWait(browserPort)
}

func startApiServer(path string, port int) {
	// TODO: Update gin to run in release mode (not debug mode, except by flag)
	// TODO: Deal with this issue:
	// [GIN-debug] [WARNING] You trusted all proxies, this is NOT safe. We recommend you to set a value.
	// Please check https://pkg.go.dev/github.com/gin-gonic/gin#readme-don-t-trust-all-proxies for details.
	r := gin.Default()

	// Configure CORS to allow requests from the frontend on port 5173 to a different port
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	// API endpoint to serve the runbook file contents
	r.GET("/api/file", func(c *gin.Context) {
		// Determine the actual file path to read
		filePath := path

		// If path is a directory, look for runbook.md inside it
		if stat, err := os.Stat(path); err == nil && stat.IsDir() {
			filePath = filepath.Join(path, "runbook.md")
		}

		// Check if the file exists
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "File not found",
				"path":  filePath,
			})
			return
		}

		// Read the file contents
		file, err := os.Open(filePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Failed to open file",
				"path":  filePath,
			})
			return
		}
		defer file.Close()

		// Read all content
		content, err := io.ReadAll(file)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "Failed to read file",
				"path":  filePath,
			})
			return
		}

		// Return the file contents
		c.JSON(http.StatusOK, gin.H{
			"path":    filePath,
			"content": string(content),
		})
	})

	// listen and serve on 0.0.0.0:$port | localhost:$port
	r.Run(":" + fmt.Sprintf("%d", port))
}

// openBrowserAndWait opens the browser and keeps the server running
func openBrowserAndWait(port int) {
	// Open browser to localhost
	err := openBrowser("http://localhost:" + fmt.Sprintf("%d", port))
	if err != nil {
		slog.Warn("Failed to open browser", "error", err)
		slog.Info("Manual browser access", "url", "http://localhost:"+fmt.Sprintf("%d", port))
	}

	// Keep the main thread alive so the web server continues running
	slog.Info("Web server started", "url", "http://localhost:"+fmt.Sprintf("%d", port))
	fmt.Println("Press Ctrl+C to stop the server")

	// Wait indefinitely to keep the server running
	select {}
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
