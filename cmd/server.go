package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"runbooks/api"
	"runbooks/browser"
)

const (
	defaultPort           = 7825
	healthCheckInterval   = 50 * time.Millisecond
	healthCheckTimeout    = 5 * time.Second
)

// healthResponse represents the JSON response from /api/health
type healthResponse struct {
	Status      string `json:"status"`
	RunbookPath string `json:"runbookPath"`
}

// startServerAndOpen starts the server with the given config, waits for it to become
// healthy, and opens the browser. This is the shared flow for `open` and `watch`.
func startServerAndOpen(rb serverSetup, config api.ServerConfig) {
	errCh := make(chan error, 1)
	go func() { errCh <- api.StartServer(config) }()

	if err := waitForServerReady(defaultPort, rb.runbookPath, errCh); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	browser.LaunchAndWait(defaultPort)
}

// waitForServerReady polls the health endpoint until the server is ready or an error occurs.
// It verifies that the server is serving the expected runbook path to detect if another
// instance is already running.
// It returns nil if the server becomes ready, or an error if:
// - The server exits with an error (received on errCh)
// - The timeout is reached before the server becomes ready
// - Another server instance is already running (runbook path mismatch)
// - Another service is using the port
func waitForServerReady(port int, expectedRunbookPath string, errCh <-chan error) error {
	healthURL := fmt.Sprintf("http://localhost:%d/api/health", port)
	deadline := time.Now().Add(healthCheckTimeout)

	// Track if something is responding on the port (even if it's not runbooks)
	portResponding := false

	for time.Now().Before(deadline) {
		select {
		case err := <-errCh:
			// Server exited immediately (likely port in use or other startup error)
			return fmt.Errorf("server failed to start: %w", err)
		default:
			// Check if the health endpoint is responding
			resp, err := http.Get(healthURL)
			if err == nil {
				portResponding = true
				body, err := io.ReadAll(resp.Body)
				resp.Body.Close()

				if resp.StatusCode == http.StatusOK {
					if err != nil {
						time.Sleep(healthCheckInterval)
						continue
					}

					var health healthResponse
					if err := json.Unmarshal(body, &health); err != nil {
						// Got a 200 OK but not valid runbooks JSON - another service is using the port
						return fmt.Errorf("port %d is in use by another service (not runbooks)", port)
					}

					// Verify the runbook path matches
					if health.RunbookPath != expectedRunbookPath {
						if health.RunbookPath != "" {
							return fmt.Errorf("another runbooks instance is already running on port %d, serving: %s", port, health.RunbookPath)
						}
						return fmt.Errorf("another runbooks instance is already running on port %d", port)
					}

					return nil // Server is ready and serving the correct runbook
				}
				// Got a response but not 200 OK - likely another service
				// Keep trying in case our server is still starting up
			}
			// Server not ready yet, wait before retrying
			time.Sleep(healthCheckInterval)
		}
	}

	if portResponding {
		return fmt.Errorf("port %d is in use by another service (not runbooks)", port)
	}
	return fmt.Errorf("timeout waiting for server to become ready (waited %v)", healthCheckTimeout)
}
