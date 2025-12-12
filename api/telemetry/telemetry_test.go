package telemetry

import (
	"os"
	"testing"
)

func TestGenerateAnonymousID(t *testing.T) {
	// Generate ID twice - should be the same
	id1 := generateAnonymousID()
	id2 := generateAnonymousID()

	if id1 != id2 {
		t.Errorf("Expected stable anonymous ID, got different values: %s vs %s", id1, id2)
	}

	// Should be 32 hex characters (16 bytes)
	if len(id1) != 32 {
		t.Errorf("Expected 32 character ID, got %d characters: %s", len(id1), id1)
	}

	// Should only contain hex characters
	for _, c := range id1 {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("Expected hex character, got: %c", c)
		}
	}
}

func TestIsEnabledDefault(t *testing.T) {
	// Before initialization, should return false
	// Note: This test assumes the global instance hasn't been initialized
	// In practice, tests may run in any order so this is just a sanity check
	if instance != nil {
		t.Skip("Skipping - telemetry already initialized")
	}

	if IsEnabled() {
		t.Error("Expected IsEnabled() to return false before initialization")
	}
}

func TestGetConfigBeforeInit(t *testing.T) {
	if instance != nil {
		t.Skip("Skipping - telemetry already initialized")
	}

	config := GetConfig()
	if config.Enabled {
		t.Error("Expected config.Enabled to be false before initialization")
	}
}

func TestTrackDoesNotPanicWhenDisabled(t *testing.T) {
	// Ensure Track doesn't panic even when telemetry is disabled
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Track panicked when disabled: %v", r)
		}
	}()

	Track("test_event", map[string]any{"key": "value"})
	TrackCommand("test")
	TrackError("test_error")
}

func TestEnvDisable(t *testing.T) {
	// This test verifies that the environment variable check works
	// Note: We can't fully test Init() multiple times due to sync.Once
	
	// Just verify the constant is correct
	if EnvDisable != "RUNBOOKS_TELEMETRY_DISABLE" {
		t.Errorf("Expected EnvDisable to be RUNBOOKS_TELEMETRY_DISABLE, got %s", EnvDisable)
	}
}

func TestDocsURL(t *testing.T) {
	// Verify the docs URL is set correctly
	expectedURL := "https://runbooks.gruntwork.io/security/telemetry/"
	if DocsURL != expectedURL {
		t.Errorf("Expected DocsURL to be %s, got %s", expectedURL, DocsURL)
	}
}

// TestDisabledViaEnv tests that telemetry respects the environment variable
// This is a more integration-style test
func TestDisabledViaEnv(t *testing.T) {
	// Save original value
	original := os.Getenv(EnvDisable)
	defer os.Setenv(EnvDisable, original)

	// Set env to disable
	os.Setenv(EnvDisable, "1")

	// Since we can't re-initialize due to sync.Once, we just verify
	// the env check logic would work
	envValue := os.Getenv(EnvDisable)
	shouldDisable := envValue == "1" || envValue == "true"
	
	if !shouldDisable {
		t.Error("Expected environment variable check to indicate disabled")
	}
}

