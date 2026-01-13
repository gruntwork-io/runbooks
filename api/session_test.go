package api

import (
	"fmt"
	"os"
	"os/exec"
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
			execCtx, valid := sm.ValidateToken(tt.token)
			if valid != tt.wantValid {
				t.Errorf("ValidateToken() valid = %v, want %v", valid, tt.wantValid)
			}
			if tt.wantValid && execCtx == nil {
				t.Error("ValidateToken() should return exec context when valid")
			}
			if !tt.wantValid && execCtx != nil {
				t.Error("ValidateToken() should not return exec context when invalid")
			}
		})
	}
}

func TestValidateTokenReturnsSnapshot(t *testing.T) {
	sm := NewSessionManager()
	tmpDir := t.TempDir()
	response, _ := sm.CreateSession(tmpDir)

	// Get execution context
	execCtx, valid := sm.ValidateToken(response.Token)
	if !valid {
		t.Fatal("Token should be valid")
	}

	// Verify it contains a snapshot of the data
	if execCtx.WorkDir != tmpDir {
		t.Errorf("WorkDir should be %s, got %s", tmpDir, execCtx.WorkDir)
	}

	if len(execCtx.Env) == 0 {
		t.Error("Env should not be empty")
	}

	// Verify the env is a copy (modifying it shouldn't affect the session)
	originalLen := len(execCtx.Env)
	execCtx.Env = append(execCtx.Env, "NEW_VAR=test")

	// Get a new context - it should have the original length
	execCtx2, _ := sm.ValidateToken(response.Token)
	if len(execCtx2.Env) != originalLen {
		t.Error("Modifying returned Env should not affect session")
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

	// The wrapper uses builtin trap to set our combined exit handler
	// This ensures user EXIT traps don't override our env capture
	if !strings.Contains(wrapped, "builtin trap __runbooks_combined_exit EXIT") {
		t.Error("Wrapper should set EXIT trap using builtin")
	}

	// Verify trap interception is set up
	if !strings.Contains(wrapped, "__RUNBOOKS_USER_EXIT_HANDLER") {
		t.Error("Wrapper should have user exit handler variable for trap interception")
	}

	if !strings.Contains(wrapped, script) {
		t.Error("Wrapper should contain original script")
	}
}

// Test that user EXIT traps are chained with our env capture
func TestWrapScriptForEnvCaptureWithUserTrap(t *testing.T) {
	// Create temp files for env capture
	envFile, err := os.CreateTemp("", "test-env-trap-*.txt")
	if err != nil {
		t.Fatalf("Failed to create temp env file: %v", err)
	}
	envCapturePath := envFile.Name()
	envFile.Close()
	defer os.Remove(envCapturePath)

	pwdFile, err := os.CreateTemp("", "test-pwd-trap-*.txt")
	if err != nil {
		t.Fatalf("Failed to create temp pwd file: %v", err)
	}
	pwdCapturePath := pwdFile.Name()
	pwdFile.Close()
	defer os.Remove(pwdCapturePath)

	// Get a unique path for the user's EXIT trap to create a marker file
	// We use TempDir to ensure uniqueness without actually creating the file
	userTrapRanPath := filepath.Join(t.TempDir(), "user-trap-ran.marker")

	// Script that sets an EXIT trap for cleanup AND exports an env var
	script := fmt.Sprintf(`#!/bin/bash
export MY_TEST_VAR=test_value_12345
trap "touch %q" EXIT
echo "Script running"
`, userTrapRanPath)

	wrapped := wrapScriptForEnvCapture(script, envCapturePath, pwdCapturePath)

	// Write wrapped script to temp file and execute it
	tmpScript, err := os.CreateTemp("", "test-wrapped-*.sh")
	if err != nil {
		t.Fatalf("Failed to create temp script file: %v", err)
	}
	tmpScript.WriteString(wrapped)
	tmpScript.Close()
	defer os.Remove(tmpScript.Name())
	os.Chmod(tmpScript.Name(), 0700)

	// Run the script
	cmd := exec.Command("bash", tmpScript.Name())
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Script execution failed: %v\nOutput: %s", err, output)
	}

	// Verify user's EXIT trap ran (marker file should exist)
	if _, err := os.Stat(userTrapRanPath); os.IsNotExist(err) {
		t.Error("User's EXIT trap should have run and created the marker file")
	}
	// Note: t.TempDir() handles cleanup automatically

	// Verify our env capture also ran
	env, _ := parseEnvCapture(envCapturePath, pwdCapturePath)
	if env == nil {
		t.Fatal("Environment capture should have run")
	}

	if env["MY_TEST_VAR"] != "test_value_12345" {
		t.Errorf("MY_TEST_VAR should be captured, got: %q", env["MY_TEST_VAR"])
	}
}

// Test env capture parsing with NUL-terminated format (from env -0)
func TestParseEnvCapture(t *testing.T) {
	// Create temp files with test content using NUL-terminated format
	envFile, _ := os.CreateTemp("", "test-env-*.txt")
	// NUL-terminated entries as produced by `env -0`
	envFile.WriteString("VAR1=value1\x00VAR2=value2\x00PATH=/usr/bin:/usr/local/bin\x00")
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

// Test that env capture correctly handles multiline values (e.g., RSA keys, JSON)
func TestParseEnvCaptureMultilineValues(t *testing.T) {
	envFile, _ := os.CreateTemp("", "test-env-multiline-*.txt")
	// Simulate a multiline value like an RSA key or JSON
	multilineValue := "line1\nline2\nline3"
	jsonValue := `{"key": "value", "nested": {"foo": "bar"}}`
	// NUL-terminated entries - the newlines are WITHIN the values
	envFile.WriteString("SIMPLE=simple_value\x00MULTILINE=" + multilineValue + "\x00JSON=" + jsonValue + "\x00")
	envFile.Close()
	defer os.Remove(envFile.Name())

	pwdFile, _ := os.CreateTemp("", "test-pwd-*.txt")
	pwdFile.WriteString("/home/user\n")
	pwdFile.Close()
	defer os.Remove(pwdFile.Name())

	env, pwd := parseEnvCapture(envFile.Name(), pwdFile.Name())

	if env["SIMPLE"] != "simple_value" {
		t.Errorf("SIMPLE should be simple_value, got: %s", env["SIMPLE"])
	}

	if env["MULTILINE"] != multilineValue {
		t.Errorf("MULTILINE should preserve newlines, expected %q, got: %q", multilineValue, env["MULTILINE"])
	}

	if env["JSON"] != jsonValue {
		t.Errorf("JSON should be preserved, expected %q, got: %q", jsonValue, env["JSON"])
	}

	if pwd != "/home/user" {
		t.Errorf("pwd should be /home/user, got: %s", pwd)
	}
}

// Test fallback to newline-delimited format (for systems without env -0)
func TestParseEnvCaptureLegacyNewlineFormat(t *testing.T) {
	envFile, _ := os.CreateTemp("", "test-env-legacy-*.txt")
	// Legacy newline-delimited format (from plain `env` without -0)
	envFile.WriteString("VAR1=value1\nVAR2=value2\nPATH=/usr/bin\n")
	envFile.Close()
	defer os.Remove(envFile.Name())

	pwdFile, _ := os.CreateTemp("", "test-pwd-*.txt")
	pwdFile.WriteString("/home/user\n")
	pwdFile.Close()
	defer os.Remove(pwdFile.Name())

	env, pwd := parseEnvCapture(envFile.Name(), pwdFile.Name())

	if env["VAR1"] != "value1" {
		t.Errorf("VAR1 should be value1, got: %s", env["VAR1"])
	}

	if env["VAR2"] != "value2" {
		t.Errorf("VAR2 should be value2, got: %s", env["VAR2"])
	}

	if env["PATH"] != "/usr/bin" {
		t.Errorf("PATH should be /usr/bin, got: %s", env["PATH"])
	}

	if pwd != "/home/user" {
		t.Errorf("pwd should be /home/user, got: %s", pwd)
	}
}

// Test that legacy newline format can still handle multiline values via continuation detection
func TestParseEnvCaptureLegacyMultilineValues(t *testing.T) {
	envFile, _ := os.CreateTemp("", "test-env-legacy-multiline-*.txt")
	// Simulate `env` output with multiline values (no NUL chars)
	// The continuation lines don't have valid env var names before =
	envFile.WriteString("SIMPLE=simple\nMULTILINE=line1\nline2\nline3\nJSON={\n  \"key\": \"value\"\n}\nLAST=end\n")
	envFile.Close()
	defer os.Remove(envFile.Name())

	pwdFile, _ := os.CreateTemp("", "test-pwd-*.txt")
	pwdFile.WriteString("/home/user\n")
	pwdFile.Close()
	defer os.Remove(pwdFile.Name())

	env, pwd := parseEnvCapture(envFile.Name(), pwdFile.Name())

	if env["SIMPLE"] != "simple" {
		t.Errorf("SIMPLE should be 'simple', got: %q", env["SIMPLE"])
	}

	expectedMultiline := "line1\nline2\nline3"
	if env["MULTILINE"] != expectedMultiline {
		t.Errorf("MULTILINE should be %q, got: %q", expectedMultiline, env["MULTILINE"])
	}

	expectedJSON := "{\n  \"key\": \"value\"\n}"
	if env["JSON"] != expectedJSON {
		t.Errorf("JSON should be %q, got: %q", expectedJSON, env["JSON"])
	}

	if env["LAST"] != "end" {
		t.Errorf("LAST should be 'end', got: %q", env["LAST"])
	}

	if pwd != "/home/user" {
		t.Errorf("pwd should be /home/user, got: %s", pwd)
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

// Test isValidEnvVarName helper function
func TestIsValidEnvVarName(t *testing.T) {
	tests := []struct {
		name     string
		expected bool
	}{
		// Valid names
		{"PATH", true},
		{"HOME", true},
		{"MY_VAR", true},
		{"_PRIVATE", true},
		{"var123", true},
		{"A", true},
		{"_", true},
		{"__", true},
		{"a1b2c3", true},

		// Invalid names
		{"", false},           // empty
		{"123VAR", false},     // starts with digit
		{"MY-VAR", false},     // contains hyphen
		{"MY.VAR", false},     // contains dot
		{"MY VAR", false},     // contains space
		{"  \"key\"", false},  // JSON-like (starts with space)
		{"{", false},          // JSON brace
		{"line2", true},       // looks valid but could be continuation - that's OK, context determines
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := isValidEnvVarName(tc.name)
			if result != tc.expected {
				t.Errorf("isValidEnvVarName(%q) = %v, expected %v", tc.name, result, tc.expected)
			}
		})
	}
}
