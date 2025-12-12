// Package telemetry provides anonymous usage tracking for Runbooks.
// Telemetry is enabled by default but can be disabled via:
//   - Environment variable: RUNBOOKS_TELEMETRY_DISABLE=1
//   - CLI flag: --no-telemetry
//
// We collect minimal, anonymous data to improve Runbooks:
//   - Commands used (open, watch, serve)
//   - OS and architecture
//   - Runbooks version
//   - Error types (not content)
//
// We do NOT collect:
//   - Runbook content or file paths
//   - Variable values or script contents
//   - Personal identifiable information
//
// Learn more: https://runbooks.gruntwork.io/security/telemetry/
package telemetry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/user"
	"runtime"
	"sync"
	"time"

	"github.com/mixpanel/mixpanel-go"
)

const (
	// EnvDisable is the environment variable to disable telemetry
	EnvDisable = "RUNBOOKS_TELEMETRY_DISABLE"

	// DocsURL is the documentation URL for telemetry
	DocsURL = "https://runbooks.gruntwork.io/security/telemetry/"
)

var (
	// MixpanelToken is the project token for Runbooks telemetry
	// This is set via ldflags at build time:
	//   go build -ldflags "-X runbooks/api/telemetry.MixpanelToken=your_token"
	// This is a public token - it only allows sending events, not reading data
	MixpanelToken = ""
)

var (
	// Global telemetry instance
	instance *Telemetry
	once     sync.Once
)

// Telemetry handles anonymous usage tracking
type Telemetry struct {
	enabled     bool
	version     string
	anonymousID string
	client      *mixpanel.ApiClient
	mu          sync.Mutex
}

// Config holds telemetry configuration for API responses
type Config struct {
	Enabled     bool   `json:"enabled"`
	AnonymousID string `json:"anonymousId"`
	Version     string `json:"version"`
}

// Init initializes the global telemetry instance
// Should be called once at startup with the application version
func Init(version string, disabledByFlag bool) {
	once.Do(func() {
		instance = &Telemetry{
			version: version,
		}

		// Check if telemetry is disabled via environment variable or flag
		if os.Getenv(EnvDisable) == "1" || os.Getenv(EnvDisable) == "true" || disabledByFlag {
			instance.enabled = false
			return
		}

		// Check if Mixpanel token is configured (set at build time via ldflags)
		if MixpanelToken == "" {
			instance.enabled = false
			return
		}

		instance.enabled = true
		instance.anonymousID = generateAnonymousID()

		// Initialize Mixpanel client
		instance.client = mixpanel.NewApiClient(MixpanelToken)
	})
}

// IsEnabled returns whether telemetry is enabled
func IsEnabled() bool {
	if instance == nil {
		return false
	}
	return instance.enabled
}

// GetConfig returns the telemetry configuration for API responses
func GetConfig() Config {
	if instance == nil {
		return Config{Enabled: false}
	}
	return Config{
		Enabled:     instance.enabled,
		AnonymousID: instance.anonymousID,
		Version:     instance.version,
	}
}

// Track sends an event to Mixpanel asynchronously
// This function never blocks and silently ignores errors
func Track(event string, properties map[string]any) {
	if instance == nil || !instance.enabled || instance.client == nil {
		return
	}

	// Run tracking in a goroutine to avoid blocking
	go func() {
		instance.mu.Lock()
		defer instance.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Add standard properties
		props := make(map[string]any)
		for k, v := range properties {
			props[k] = v
		}
		props["$os"] = runtime.GOOS
		props["$os_version"] = runtime.GOARCH
		props["version"] = instance.version
		props["time"] = time.Now().Unix()

		// Create and send the event
		eventData := instance.client.NewEvent(event, instance.anonymousID, props)

		// Silently ignore errors - telemetry should never impact user experience
		_ = instance.client.Track(ctx, []*mixpanel.Event{eventData})
	}()
}

// TrackCommand is a convenience function for tracking CLI command usage
func TrackCommand(command string) {
	Track("command_invoked", map[string]any{
		"command": command,
	})
}

// TrackError is a convenience function for tracking error types
// Note: We only track the error type, never the error message or content
func TrackError(errorType string) {
	Track("error_occurred", map[string]any{
		"error_type": errorType,
	})
}

// PrintNotice prints a telemetry notice to stdout
// This should be called on every command invocation when telemetry is enabled
func PrintNotice() {
	if !IsEnabled() {
		return
	}

	fmt.Printf("\n📊 Telemetry is enabled. Set %s=1 to opt out.\n", EnvDisable)
	fmt.Printf("   Learn more: %s\n\n", DocsURL)
}

// generateAnonymousID creates a stable, anonymous identifier for this machine
// The ID is a SHA-256 hash of hostname + username, making it:
// - Stable: Same ID across sessions on the same machine
// - Anonymous: Cannot be reversed to identify the user
// - Unique: Different for each machine/user combination
func generateAnonymousID() string {
	hostname, _ := os.Hostname()
	username := ""
	if u, err := user.Current(); err == nil {
		username = u.Username
	}

	// Create a hash of hostname + username
	data := fmt.Sprintf("runbooks:%s:%s", hostname, username)
	hash := sha256.Sum256([]byte(data))

	// Return first 16 bytes as hex (32 characters) - enough for uniqueness
	return hex.EncodeToString(hash[:16])
}

// Shutdown gracefully shuts down telemetry
// This is a no-op currently but reserved for future use
func Shutdown() {
	// Currently a no-op, but could be used to flush pending events
}

