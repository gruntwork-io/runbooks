package api

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// =============================================================================
// Path Validation
// =============================================================================

// ValidateWorkspacePath ensures the path is within the allowed output directory
// and doesn't contain directory traversal attempts
func ValidateWorkspacePath(workspacePath, outputPath string) error {
	// Ensure path is absolute
	absWorkspace, err := filepath.Abs(workspacePath)
	if err != nil {
		return fmt.Errorf("invalid workspace path: %w", err)
	}

	absOutput, err := filepath.Abs(outputPath)
	if err != nil {
		return fmt.Errorf("invalid output path: %w", err)
	}

	// Ensure workspace is within the git-workspaces subdirectory of output
	gitWorkspacesDir := filepath.Join(absOutput, "git-workspaces")
	
	// Check that the workspace path starts with the git-workspaces directory
	if !strings.HasPrefix(absWorkspace, gitWorkspacesDir) {
		return fmt.Errorf("workspace path must be within the git-workspaces directory")
	}

	return nil
}

// ValidateBranchName ensures the branch name is safe
func ValidateBranchName(branch string) error {
	if branch == "" {
		return fmt.Errorf("branch name cannot be empty")
	}

	// Check for path traversal
	if strings.Contains(branch, "..") {
		return fmt.Errorf("branch name cannot contain '..'")
	}

	// Check for spaces
	if strings.Contains(branch, " ") {
		return fmt.Errorf("branch name cannot contain spaces")
	}

	// Check for control characters
	for _, c := range branch {
		if c < 32 || c == 127 {
			return fmt.Errorf("branch name cannot contain control characters")
		}
	}

	// Git branch naming rules
	invalidPatterns := []string{
		"^-",          // Cannot start with dash
		"\\.\\.+",     // Cannot contain consecutive dots
		"@{",          // Cannot contain @{
		"\\\\",        // Cannot contain backslash
		"~",           // Cannot contain tilde
		"\\^",         // Cannot contain caret
		":",           // Cannot contain colon
		"\\?",         // Cannot contain question mark
		"\\*",         // Cannot contain asterisk
		"\\[",         // Cannot contain open bracket
	}

	for _, pattern := range invalidPatterns {
		if matched, _ := regexp.MatchString(pattern, branch); matched {
			return fmt.Errorf("branch name contains invalid character(s)")
		}
	}

	// Cannot end with .lock
	if strings.HasSuffix(branch, ".lock") {
		return fmt.Errorf("branch name cannot end with '.lock'")
	}

	return nil
}

// =============================================================================
// Secret Detection
// =============================================================================

// SecretPattern represents a pattern for detecting secrets
type SecretPattern struct {
	Name    string
	Pattern *regexp.Regexp
}

// Common secret patterns
var secretPatterns = []SecretPattern{
	{Name: "AWS Access Key ID", Pattern: regexp.MustCompile(`(?i)AKIA[0-9A-Z]{16}`)},
	{Name: "AWS Secret Access Key", Pattern: regexp.MustCompile(`(?i)aws.{0,20}secret.{0,20}['\"][0-9a-zA-Z/+]{40}['"]`)},
	{Name: "GitHub Token", Pattern: regexp.MustCompile(`ghp_[0-9a-zA-Z]{36}`)},
	{Name: "GitHub OAuth Token", Pattern: regexp.MustCompile(`gho_[0-9a-zA-Z]{36}`)},
	{Name: "GitHub App Token", Pattern: regexp.MustCompile(`(ghu|ghs)_[0-9a-zA-Z]{36}`)},
	{Name: "Private Key", Pattern: regexp.MustCompile(`-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`)},
	{Name: "Generic API Key", Pattern: regexp.MustCompile(`(?i)(api[_-]?key|apikey)['\"]?\s*[:=]\s*['\"][0-9a-zA-Z]{16,}['"]`)},
	{Name: "Generic Secret", Pattern: regexp.MustCompile(`(?i)(secret|password|passwd|pwd)['\"]?\s*[:=]\s*['\"][^\s'\"]{8,}['"]`)},
	{Name: "JWT Token", Pattern: regexp.MustCompile(`eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*`)},
}

// SecretMatch represents a detected secret
type SecretMatch struct {
	PatternName string
	FilePath    string
	LineNumber  int
	Match       string // Redacted version of the match
}

// ScanContentForSecrets scans content for potential secrets
func ScanContentForSecrets(content string, filePath string) []SecretMatch {
	var matches []SecretMatch

	lines := strings.Split(content, "\n")
	for lineNum, line := range lines {
		for _, pattern := range secretPatterns {
			if pattern.Pattern.MatchString(line) {
				// Redact the actual secret for safety
				redactedMatch := pattern.Pattern.ReplaceAllString(line, "[REDACTED]")
				matches = append(matches, SecretMatch{
					PatternName: pattern.Name,
					FilePath:    filePath,
					LineNumber:  lineNum + 1,
					Match:       redactedMatch,
				})
			}
		}
	}

	return matches
}

// =============================================================================
// Sensitive Files
// =============================================================================

// SensitiveFilePatterns lists file patterns that shouldn't be committed
var SensitiveFilePatterns = []string{
	".env",
	".env.local",
	".env.*.local",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"credentials",
	"credentials.json",
	".aws/credentials",
	".npmrc",
	".pypirc",
	"*.secrets",
	"secrets.yml",
	"secrets.yaml",
	"secrets.json",
}

// IsSensitiveFile checks if a file path matches sensitive file patterns
func IsSensitiveFile(filePath string) bool {
	fileName := filepath.Base(filePath)
	
	for _, pattern := range SensitiveFilePatterns {
		// Simple pattern matching
		if matched, _ := filepath.Match(pattern, fileName); matched {
			return true
		}
		// Also check full path for patterns with directories
		if matched, _ := filepath.Match(pattern, filePath); matched {
			return true
		}
	}

	return false
}

// FilterSensitiveFiles filters out sensitive files from a list
func FilterSensitiveFiles(files []GitFileStatus) (safe []GitFileStatus, sensitive []GitFileStatus) {
	for _, file := range files {
		if IsSensitiveFile(file.Path) {
			sensitive = append(sensitive, file)
		} else {
			safe = append(safe, file)
		}
	}
	return
}
