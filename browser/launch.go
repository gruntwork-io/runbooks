package browser

import (
	"fmt"
	"log/slog"
	"os/exec"
	"runtime"
)

// LaunchAndWait opens the browser and keeps the server running
func LaunchAndWait(port int) {
	url := "http://localhost:" + fmt.Sprintf("%d", port)
	
	// Open browser to localhost
	err := launch(url)
	if err != nil {
		slog.Warn("Failed to open browser", "error", err)
		slog.Info("Manual browser access", "url", url)
	}

	// Keep the main thread alive so the web server continues running
	slog.Info("Web server started", "url", url)
	fmt.Println("Press Ctrl+C to stop the server")

	// Wait indefinitely to keep the server running
	select {}
}

// launch opens the specified URL in the default browser
func launch(url string) error {
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
