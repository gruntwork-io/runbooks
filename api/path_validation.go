package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// This file centralizes path validation logic for output paths.
//
// IMPORTANT: These validations offer LIMITED security value and are candidates
// for future removal. Since runbooks execute arbitrary user scripts that have
// full filesystem access, restricting output paths doesn't create a meaningful
// security boundary - a user who wants to write outside the output directory
// could simply do so in a script instead.
//
// The primary value these checks provide is catching accidental misconfiguration
// (e.g., typos like "../oops") with clear error messages, rather than letting
// boilerplate fail with cryptic errors or silently write to unexpected locations.

// =============================================================================
// Core Validation Functions
// =============================================================================

// ContainsPathTraversal checks if a path contains ".." components that could
// be used for directory traversal attacks.
//
// This checks the raw path before any normalization, catching attempts like:
// - ".."
// - "../foo"
// - "foo/../bar"
// - "foo/.."
func ContainsPathTraversal(path string) bool {
	// Normalize path separators for cross-platform checking
	normalizedPath := filepath.ToSlash(path)

	// Check for ".." as a path component
	parts := strings.Split(normalizedPath, "/")
	for _, part := range parts {
		if part == ".." {
			return true
		}
	}

	return false
}

// IsAbsolutePath checks if a path is absolute (Unix or Windows style).
// This catches both `/etc/passwd` and `C:\Windows\System32`.
func IsAbsolutePath(path string) bool {
	if filepath.IsAbs(path) {
		return true
	}

	// Additional check for Windows paths on Unix systems (e.g., "C:/...")
	if len(path) >= 2 && path[1] == ':' {
		return true
	}

	return false
}

// =============================================================================
// Path Validation Functions
// =============================================================================

// ValidateRelativePath performs basic validation on a relative path.
//
// USE THIS WHEN:
// - You're validating an untrusted path (e.g. from an API request or user input)
// - You don't have a base directory yet (early validation)
// - You just need to check the path structure is safe
//
// USE ValidateRelativePathIn INSTEAD WHEN:
// - You have a base directory and need to verify containment
// - You're about to perform file I/O operations
//
// Checks performed:
// - Path is not absolute
// - Path does not contain ".." traversal components
//
// Empty paths are allowed (will use defaults).
func ValidateRelativePath(path string) error {
	// Empty path is allowed (will use default)
	if path == "" {
		return nil
	}

	// Check for absolute paths
	if IsAbsolutePath(path) {
		return fmt.Errorf("absolute paths are not allowed: %s", path)
	}

	// Check for directory traversal attempts
	if ContainsPathTraversal(path) {
		return fmt.Errorf("directory traversal is not allowed: %s", path)
	}

	return nil
}

// ValidateRelativePathIn performs full validation on a relative path within a directory.
//
// USE THIS WHEN:
// - You have a base directory and need to verify the path stays within it
// - You're about to perform file I/O operations (read, write, delete)
// - You need detailed error messages to report to users
//
// USE ValidateRelativePath INSTEAD WHEN:
// - You don't have a base directory yet (early validation)
// - You just need basic path structure validation
//
// USE IsContainedIn INSTEAD WHEN:
// - You just need a quick yes/no answer for control flow
// - You don't need detailed error messages
//
// Checks performed:
// 1. Path is not empty
// 2. Path is not absolute (via ValidateRelativePath)
// 3. Path does not contain ".." traversal components (via ValidateRelativePath)
// 4. After joining with dir, the result stays within dir
//
// Returns a descriptive error if validation fails, nil if the path is safe.
func ValidateRelativePathIn(path string, dir string) error {
	// Reject empty paths (unlike ValidateRelativePath which allows them)
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}

	// Reuse ValidateRelativePath for the common checks (absolute paths, traversal)
	if err := ValidateRelativePath(path); err != nil {
		return err
	}

	// Defense-in-depth: after joining, verify the result is within dir
	// This catches edge cases the above checks might miss
	fullPath := filepath.Join(dir, path)
	absFullPath, err := filepath.Abs(fullPath)
	if err != nil {
		return fmt.Errorf("failed to resolve absolute path: %w", err)
	}

	absDir, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("failed to resolve directory: %w", err)
	}

	// Ensure the full path starts with the directory
	// We add a separator to prevent matching partial directory names
	// e.g., /foo/bar should not match /foo/barbaz
	if !strings.HasPrefix(absFullPath, absDir+string(filepath.Separator)) && absFullPath != absDir {
		return fmt.Errorf("path escapes directory: %s (resolved to %s, dir is %s)", path, absFullPath, absDir)
	}

	return nil
}

// =============================================================================
// Simple Containment Checks (for control flow)
// =============================================================================

// IsContainedIn checks if a path is within (or equal to) a container directory.
// Returns true if the path is safely contained, false otherwise.
//
// USE THIS WHEN:
// - You need a quick yes/no answer for control flow (loops, conditionals)
// - You're checking an already-processed path during iteration
// - You don't need detailed error messages, just a boolean decision
//
// DON'T USE THIS WHEN:
// - You have untrusted input that needs full validation (use ValidateRelativePath)
// - You need to report detailed errors to users (use ValidateRelativePath)
//
// Works with both relative and absolute paths. Paths are resolved to absolute
// before comparison.
func IsContainedIn(path, container string) bool {
	// Resolve both paths to absolute
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}

	absContainer, err := filepath.Abs(container)
	if err != nil {
		return false
	}

	// Check if path equals container
	if absPath == absContainer {
		return true
	}

	// Check if path is under container
	// Use filepath.Rel - if result starts with "..", path is outside container
	relPath, err := filepath.Rel(absContainer, absPath)
	if err != nil {
		return false
	}

	// If relative path starts with "..", it's outside the container
	if relPath == ".." {
		return false
	}
	if len(relPath) >= 3 && relPath[:3] == ".."+string(filepath.Separator) {
		return false
	}

	return true
}

// IsFilesystemRoot checks if a path is the filesystem root.
// Works cross-platform: "/" on Unix, "C:\" on Windows.
func IsFilesystemRoot(path string) bool {
	return filepath.Dir(path) == path
}

// =============================================================================
// Absolute Path Validation (for pre-resolved paths)
// =============================================================================

// ValidateAbsolutePathInCwd checks if an absolute path is safe for file operations.
//
// USE THIS WHEN:
// - You have an absolute path (already resolved by caller)
// - You need to ensure it's within the current working directory
// - You're about to perform file operations (read, write, delete)
//
// This is the sibling of ValidateRelativePathIn - one for relative paths,
// one for absolute paths.
//
// Checks performed:
// 1. Path is not empty
// 2. Path is absolute (rejects relative paths)
// 3. Path is within CWD (after resolving symlinks)
// 4. Path is not a system-critical directory
func ValidateAbsolutePathInCwd(path string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current working directory: %w", err)
	}
	return ValidateAbsolutePathInDir(path, cwd)
}

// ValidateAbsolutePathInDir checks if an absolute path is safe for file operations
// and is contained within the specified base directory.
//
// USE THIS WHEN:
// - You have an absolute path (already resolved by caller)
// - You need to ensure it's within a specific base directory (not necessarily CWD)
// - You're about to perform file operations (read, write, delete)
//
// This is used by generated files validation where the working directory may differ
// from the process CWD (e.g., when using --working-dir-tmp or remote runbooks).
//
// Checks performed:
// 1. Path is not empty
// 2. Path is absolute (rejects relative paths)
// 3. Path is within baseDir (after resolving symlinks)
// 4. Path is not a system-critical directory
func ValidateAbsolutePathInDir(path string, baseDir string) error {
	// Reject empty paths
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}

	// Require absolute path - caller must resolve before calling
	if !filepath.IsAbs(path) {
		return fmt.Errorf("path must be absolute: %s", path)
	}

	// Resolve symlinks to get the actual target path
	// This prevents attacks using symlinks pointing outside the base dir
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		// If the path doesn't exist yet, EvalSymlinks will fail
		// In that case, just use the provided path
		resolvedPath = path
	}

	// Clean the path to resolve any . or .. components
	cleanPath := filepath.Clean(resolvedPath)

	// Resolve symlinks for base dir as well (e.g., on macOS /tmp -> /private/tmp)
	// This ensures consistent comparison when both paths involve symlinks
	resolvedBaseDir, err := filepath.EvalSymlinks(baseDir)
	if err != nil {
		// If we can't resolve symlinks on the base dir, it's a sign of a problem.
		// It's better to fail fast than to proceed with a potentially incorrect path.
		return fmt.Errorf("failed to resolve symlinks for base directory %q: %w", baseDir, err)
	}

	// The path must be within or equal to the base directory
	rel, err := filepath.Rel(resolvedBaseDir, cleanPath)
	if err != nil {
		return fmt.Errorf("failed to compute relative path: %w", err)
	}

	// If rel starts with "..", it's outside the base directory
	// (filepath.Rel always returns a relative path, so no need to check filepath.IsAbs)
	if len(rel) >= 2 && rel[0] == '.' && rel[1] == '.' {
		return fmt.Errorf("path must be within base directory (path: %s, base: %s)", cleanPath, resolvedBaseDir)
	}

	// Reject system-critical directories
	if err := validateNotSystemDirectory(cleanPath); err != nil {
		return err
	}

	return nil
}

// validateNotSystemDirectory checks that a path is not a system-critical directory
func validateNotSystemDirectory(cleanPath string) error {
	// Normalize path for comparison (use ToSlash for cross-platform comparison)
	normalizedPath := filepath.ToSlash(strings.ToLower(cleanPath))

	dangerousPaths := []string{
		"/",
		"/bin",
		"/boot",
		"/dev",
		"/etc",
		"/home",
		"/lib",
		"/lib64",
		"/opt",
		"/proc",
		"/root",
		"/sbin",
		"/sys",
		"/usr",
		"/var",
		"c:/",
		"c:/windows",
		"c:/program files",
		"c:/program files (x86)",
		"c:/users",
	}

	for _, dangerous := range dangerousPaths {
		if normalizedPath == dangerous {
			return fmt.Errorf("output path is not valid: cannot use system directory: %s", cleanPath)
		}
	}

	return nil
}

