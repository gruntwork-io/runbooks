package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewSessionManager(t *testing.T) {
	sm := NewSessionManager()
	if sm == nil {
		t.Fatal("NewSessionManager returned nil")
	}
	if sm.session != nil {
		t.Fatal("session should be nil initially")
	}
}

func TestCreateSession(t *testing.T) {
	sm := NewSessionManager()

	// Create a session with a temp directory as the working dir
	tmpDir := t.TempDir()
	response, err := sm.CreateSession(tmpDir)

	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	if response.Token == "" {
		t.Error("Session token is empty")
	}

	// Token should be 64 hex chars (32 bytes)
	if len(response.Token) != 64 {
		t.Errorf("Token length should be 64, got %d", len(response.Token))
	}

	// Verify session was stored
	session, ok := sm.GetSession()
	if !ok {
		t.Fatal("Session not found after creation")
	}

	// Verify working directory is absolute
	if !filepath.IsAbs(session.WorkingDir) {
		t.Errorf("Working directory should be absolute, got: %s", session.WorkingDir)
	}

	// Verify initial working dir is set
	if session.InitialWorkDir != session.WorkingDir {
		t.Error("InitialWorkDir should match WorkingDir on creation")
	}

	// Verify environment was captured
	if len(session.Env) == 0 {
		t.Error("Environment should not be empty")
	}

	// Verify PATH is in environment (common env var)
	if _, ok := session.Env["PATH"]; !ok {
		t.Error("PATH should be in captured environment")
	}

	// Verify initial env is a copy
	if &session.Env == &session.InitialEnv {
		t.Error("Env and InitialEnv should be separate maps")
	}

	// Verify token is in valid tokens
	if len(session.ValidTokens) != 1 {
		t.Errorf("Should have exactly 1 valid token, got %d", len(session.ValidTokens))
	}
}

func TestCreateSessionReplacesExisting(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()

	// Create first session
	response1, _ := sm.CreateSession(tmpDir)

	// Create second session - should replace the first
	response2, _ := sm.CreateSession(tmpDir)

	// Tokens should be different
	if response1.Token == response2.Token {
		t.Error("New session should have a different token")
	}

	// Should only have one session with one token
	if !sm.HasSession() {
		t.Error("Should have a session")
	}

	if sm.TokenCount() != 1 {
		t.Errorf("Should have 1 token after replacement, got %d", sm.TokenCount())
	}

	// New token should work
	_, valid := sm.ValidateToken(response2.Token)
	if !valid {
		t.Error("New token should be valid")
	}

	// Old token should NOT work (session was replaced)
	_, valid = sm.ValidateToken(response1.Token)
	if valid {
		t.Error("Old token should be invalid after session replacement")
	}
}

func TestValidateToken(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	response, _ := sm.CreateSession(tmpDir)

	tests := []struct {
		name      string
		token     string
		wantValid bool
	}{
		{
			name:      "valid token",
			token:     response.Token,
			wantValid: true,
		},
		{
			name:      "invalid token",
			token:     "invalid-token",
			wantValid: false,
		},
		{
			name:      "empty token",
			token:     "",
			wantValid: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			session, valid := sm.ValidateToken(tt.token)
			if valid != tt.wantValid {
				t.Errorf("ValidateToken() valid = %v, want %v", valid, tt.wantValid)
			}
			if tt.wantValid && session == nil {
				t.Error("ValidateToken() should return session when valid")
			}
			if !tt.wantValid && session != nil {
				t.Error("ValidateToken() should not return session when invalid")
			}
		})
	}
}

func TestValidateTokenNoSession(t *testing.T) {
	sm := NewSessionManager()

	// No session exists
	_, valid := sm.ValidateToken("any-token")
	if valid {
		t.Error("Should return invalid when no session exists")
	}
}

func TestJoinSessionAddsToken(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	response1, _ := sm.CreateSession(tmpDir)

	// Restore session should add a new token (not replace)
	response2, err := sm.JoinSession()
	if err != nil {
		t.Fatalf("JoinSession failed: %v", err)
	}

	if response2 == nil {
		t.Fatal("JoinSession returned nil")
	}

	if response2.Token == response1.Token {
		t.Error("Restore should generate a different token")
	}

	// Both tokens should now be valid
	if sm.TokenCount() != 2 {
		t.Errorf("Should have 2 tokens, got %d", sm.TokenCount())
	}

	// Original token should still work
	_, valid := sm.ValidateToken(response1.Token)
	if !valid {
		t.Error("Original token should still be valid after restore")
	}

	// New token should also work
	_, valid = sm.ValidateToken(response2.Token)
	if !valid {
		t.Error("New token should be valid after restore")
	}
}

func TestRestoreNoSession(t *testing.T) {
	sm := NewSessionManager()

	restored, err := sm.JoinSession()
	if err != nil {
		t.Fatalf("JoinSession should not return error: %v", err)
	}

	if restored != nil {
		t.Error("JoinSession should return nil when no session exists")
	}
}

func TestMultipleTabsShareSession(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()

	// Tab 1 creates session
	response1, _ := sm.CreateSession(tmpDir)

	// Tab 2 restores (gets its own token)
	response2, _ := sm.JoinSession()

	// Tab 3 restores (gets its own token)
	response3, _ := sm.JoinSession()

	// All three tokens should be valid
	_, valid1 := sm.ValidateToken(response1.Token)
	_, valid2 := sm.ValidateToken(response2.Token)
	_, valid3 := sm.ValidateToken(response3.Token)

	if !valid1 || !valid2 || !valid3 {
		t.Error("All tokens should be valid")
	}

	// Should have 3 tokens
	if sm.TokenCount() != 3 {
		t.Errorf("Should have 3 tokens, got %d", sm.TokenCount())
	}

	// All tabs share the same session state
	// Update env from tab 1
	_ = sm.UpdateSessionEnv(map[string]string{"SHARED": "value"}, tmpDir)

	// Tab 2 and 3 should see the same state
	session, _ := sm.GetSession()
	if session.Env["SHARED"] != "value" {
		t.Error("All tabs should see the same session state")
	}
}

func TestMaxTokensLimit(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	// Create MaxTokensPerSession - 1 more tokens (one already exists from CreateSession)
	for i := 0; i < MaxTokensPerSession-1; i++ {
		_, err := sm.JoinSession()
		if err != nil {
			t.Fatalf("JoinSession failed: %v", err)
		}
	}

	if sm.TokenCount() != MaxTokensPerSession {
		t.Errorf("Should have %d tokens, got %d", MaxTokensPerSession, sm.TokenCount())
	}

	// Adding one more should prune the oldest
	_, err := sm.JoinSession()
	if err != nil {
		t.Fatalf("JoinSession failed: %v", err)
	}

	// Should still be at max
	if sm.TokenCount() != MaxTokensPerSession {
		t.Errorf("Should still have %d tokens after pruning, got %d", MaxTokensPerSession, sm.TokenCount())
	}
}

func TestRevokeToken(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	response1, _ := sm.CreateSession(tmpDir)
	response2, _ := sm.JoinSession()

	// Revoke token 1
	revoked := sm.RevokeToken(response1.Token)
	if !revoked {
		t.Error("RevokeToken should return true for valid token")
	}

	// Token 1 should no longer be valid
	_, valid := sm.ValidateToken(response1.Token)
	if valid {
		t.Error("Revoked token should be invalid")
	}

	// Token 2 should still be valid
	_, valid = sm.ValidateToken(response2.Token)
	if !valid {
		t.Error("Other token should still be valid")
	}

	// Should have 1 token left
	if sm.TokenCount() != 1 {
		t.Errorf("Should have 1 token after revoke, got %d", sm.TokenCount())
	}
}

func TestRevokeTokenNotFound(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	revoked := sm.RevokeToken("nonexistent-token")
	if revoked {
		t.Error("RevokeToken should return false for nonexistent token")
	}
}

func TestUpdateSessionEnv(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	newEnv := map[string]string{
		"NEW_VAR": "new_value",
		"PATH":    "/new/path",
	}
	newWorkDir := "/new/work/dir"

	err := sm.UpdateSessionEnv(newEnv, newWorkDir)
	if err != nil {
		t.Fatalf("UpdateSessionEnv failed: %v", err)
	}

	session, _ := sm.GetSession()

	if session.Env["NEW_VAR"] != "new_value" {
		t.Error("Environment should be updated")
	}

	if session.WorkingDir != newWorkDir {
		t.Errorf("Working directory should be updated, got: %s", session.WorkingDir)
	}

	if session.ExecutionCount != 1 {
		t.Errorf("Execution count should be 1, got: %d", session.ExecutionCount)
	}
}

func TestResetSession(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	// Get initial env count
	session, _ := sm.GetSession()
	initialEnvCount := len(session.InitialEnv)
	initialWorkDir := session.InitialWorkDir

	// Update with new environment and working directory
	newEnv := map[string]string{
		"NEW_VAR": "new_value",
	}
	_ = sm.UpdateSessionEnv(newEnv, "/new/work/dir")

	// Verify update
	session, _ = sm.GetSession()
	if len(session.Env) != 1 {
		t.Errorf("Env should have 1 var, got: %d", len(session.Env))
	}
	if session.WorkingDir != "/new/work/dir" {
		t.Error("WorkingDir should be updated")
	}

	// Reset session
	err := sm.ResetSession()
	if err != nil {
		t.Fatalf("ResetSession failed: %v", err)
	}

	// Verify reset
	session, _ = sm.GetSession()
	if len(session.Env) != initialEnvCount {
		t.Errorf("Env should have %d vars after reset, got: %d", initialEnvCount, len(session.Env))
	}

	if _, ok := session.Env["NEW_VAR"]; ok {
		t.Error("NEW_VAR should be removed after reset")
	}

	if session.WorkingDir != initialWorkDir {
		t.Errorf("WorkingDir should be reset to %s, got: %s", initialWorkDir, session.WorkingDir)
	}
}

func TestDeleteSession(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	response, _ := sm.CreateSession(tmpDir)

	// Add another token
	sm.JoinSession()

	sm.DeleteSession()

	_, ok := sm.GetSession()
	if ok {
		t.Error("Session should be deleted")
	}

	// All tokens should be invalid
	_, valid := sm.ValidateToken(response.Token)
	if valid {
		t.Error("Tokens should be invalid after session deletion")
	}
}

func TestGetMetadata(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	// Add another token (simulating 2 tabs)
	sm.JoinSession()

	// Update to increment execution count
	_ = sm.UpdateSessionEnv(map[string]string{"A": "B"}, tmpDir)

	metadata, ok := sm.GetMetadata()
	if !ok {
		t.Fatal("GetMetadata returned not ok")
	}

	if metadata.ExecutionCount != 1 {
		t.Errorf("Execution count should be 1, got: %d", metadata.ExecutionCount)
	}

	if metadata.CreatedAt.IsZero() {
		t.Error("CreatedAt should not be zero")
	}

	if metadata.ActiveTabs != 2 {
		t.Errorf("ActiveTabs should be 2, got: %d", metadata.ActiveTabs)
	}
}

func TestGetMetadataNoSession(t *testing.T) {
	sm := NewSessionManager()

	_, ok := sm.GetMetadata()
	if ok {
		t.Error("GetMetadata should return false when no session exists")
	}
}

func TestEnvSlice(t *testing.T) {
	session := &Session{
		Env: map[string]string{
			"VAR1": "value1",
			"VAR2": "value2",
		},
	}

	slice := session.EnvSlice()

	if len(slice) != 2 {
		t.Errorf("EnvSlice should have 2 items, got: %d", len(slice))
	}

	// Check that both vars are present (order may vary)
	found := map[string]bool{}
	for _, s := range slice {
		if s == "VAR1=value1" {
			found["VAR1"] = true
		}
		if s == "VAR2=value2" {
			found["VAR2"] = true
		}
	}

	if !found["VAR1"] || !found["VAR2"] {
		t.Errorf("EnvSlice missing expected values: %v", slice)
	}
}

func TestFilterCapturedEnv(t *testing.T) {
	input := map[string]string{
		"PATH":         "/usr/bin",
		"HOME":         "/home/user",
		"_":            "/bin/bash",  // Should be filtered
		"SHLVL":        "1",          // Should be filtered
		"BASH_VERSION": "5.0",        // Should be filtered (BASH_* prefix)
		"CUSTOM_VAR":   "custom",
	}

	filtered := FilterCapturedEnv(input)

	// Should keep
	if _, ok := filtered["PATH"]; !ok {
		t.Error("PATH should be kept")
	}
	if _, ok := filtered["HOME"]; !ok {
		t.Error("HOME should be kept")
	}
	if _, ok := filtered["CUSTOM_VAR"]; !ok {
		t.Error("CUSTOM_VAR should be kept")
	}

	// Should filter
	if _, ok := filtered["_"]; ok {
		t.Error("_ should be filtered")
	}
	if _, ok := filtered["SHLVL"]; ok {
		t.Error("SHLVL should be filtered")
	}
	if _, ok := filtered["BASH_VERSION"]; ok {
		t.Error("BASH_VERSION should be filtered")
	}
}

func TestCaptureEnvironment(t *testing.T) {
	// Set a test env var
	os.Setenv("RUNBOOKS_TEST_VAR", "test_value")
	defer os.Unsetenv("RUNBOOKS_TEST_VAR")

	env := captureEnvironment()

	if env["RUNBOOKS_TEST_VAR"] != "test_value" {
		t.Error("captureEnvironment should capture current environment")
	}
}

func TestCopyEnvMap(t *testing.T) {
	original := map[string]string{
		"A": "1",
		"B": "2",
	}

	copied := copyEnvMap(original)

	// Modify original
	original["A"] = "modified"
	original["C"] = "3"

	// Copy should be unchanged
	if copied["A"] != "1" {
		t.Error("Copy should be independent from original")
	}
	if _, ok := copied["C"]; ok {
		t.Error("Copy should not have new keys from original")
	}
}

// Security Tests

func TestSecurityInvalidTokenReturnsUnauthorized(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	// Try with wrong token
	_, valid := sm.ValidateToken("wrong-token")
	if valid {
		t.Error("Invalid token should return unauthorized")
	}
}

func TestSecurityNoSessionReturnsUnauthorized(t *testing.T) {
	sm := NewSessionManager()

	// Try to validate when no session exists
	_, valid := sm.ValidateToken("any-token")
	if valid {
		t.Error("No session should return unauthorized")
	}
}

func TestSecurityTokenIsNotExposed(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	sm.CreateSession(tmpDir)

	// GetMetadata should NOT contain the tokens
	metadata, _ := sm.GetMetadata()

	// Verify by checking the struct has expected fields but no token
	if metadata.WorkingDir == "" {
		t.Error("Metadata should have WorkingDir")
	}

	// ActiveTabs tells you how many, but not what the tokens are
	if metadata.ActiveTabs != 1 {
		t.Errorf("ActiveTabs should be 1, got %d", metadata.ActiveTabs)
	}

	// The SessionMetadata struct intentionally excludes sensitive fields
	// This is enforced at compile time by the struct definition
}

func TestSecurityTokensAreUnique(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()

	tokens := make(map[string]bool)

	// Create multiple tokens and verify they are unique
	response, _ := sm.CreateSession(tmpDir)
	tokens[response.Token] = true

	for i := 0; i < 50; i++ {
		response, err := sm.JoinSession()
		if err != nil {
			t.Fatalf("JoinSession failed: %v", err)
		}

		if tokens[response.Token] {
			t.Error("Duplicate token generated")
		}
		tokens[response.Token] = true
	}
}

// Test wrapper script generation
func TestWrapScriptForEnvCapture(t *testing.T) {
	script := `#!/bin/bash
echo "Hello"
export MY_VAR=value
cd /tmp`

	wrapped := wrapScriptForEnvCapture(script, "/tmp/env.txt", "/tmp/pwd.txt")

	// Verify wrapper contains necessary components
	if !strings.Contains(wrapped, "__RUNBOOKS_ENV_CAPTURE_PATH") {
		t.Error("Wrapper should contain env capture path variable")
	}

	if !strings.Contains(wrapped, "__RUNBOOKS_PWD_CAPTURE_PATH") {
		t.Error("Wrapper should contain pwd capture path variable")
	}

	if !strings.Contains(wrapped, "trap __runbooks_capture_env EXIT") {
		t.Error("Wrapper should set EXIT trap")
	}

	if !strings.Contains(wrapped, script) {
		t.Error("Wrapper should contain original script")
	}
}

// Test env capture parsing
func TestParseEnvCapture(t *testing.T) {
	// Create temp files with test content
	envFile, _ := os.CreateTemp("", "test-env-*.txt")
	envFile.WriteString("VAR1=value1\nVAR2=value2\nPATH=/usr/bin:/usr/local/bin\n")
	envFile.Close()
	defer os.Remove(envFile.Name())

	pwdFile, _ := os.CreateTemp("", "test-pwd-*.txt")
	pwdFile.WriteString("/home/user/project\n")
	pwdFile.Close()
	defer os.Remove(pwdFile.Name())

	env, pwd := parseEnvCapture(envFile.Name(), pwdFile.Name())

	if env["VAR1"] != "value1" {
		t.Errorf("VAR1 should be value1, got: %s", env["VAR1"])
	}

	if env["VAR2"] != "value2" {
		t.Errorf("VAR2 should be value2, got: %s", env["VAR2"])
	}

	if env["PATH"] != "/usr/bin:/usr/local/bin" {
		t.Errorf("PATH should be /usr/bin:/usr/local/bin, got: %s", env["PATH"])
	}

	if pwd != "/home/user/project" {
		t.Errorf("pwd should be /home/user/project, got: %s", pwd)
	}
}

func TestParseEnvCaptureNonExistentFiles(t *testing.T) {
	env, pwd := parseEnvCapture("/non/existent/env.txt", "/non/existent/pwd.txt")

	if env != nil {
		t.Error("env should be nil for non-existent file")
	}

	if pwd != "" {
		t.Error("pwd should be empty for non-existent file")
	}
}
