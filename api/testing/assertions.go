package testing

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// runAssertion runs a single assertion and returns the result.
func (e *TestExecutor) runAssertion(assertion TestAssertion) AssertionResult {
	result := AssertionResult{
		Type: assertion.Type,
	}

	switch assertion.Type {
	case AssertionFileExists:
		result = e.assertFileExists(assertion.Path)
	case AssertionFileNotExists:
		result = e.assertFileNotExists(assertion.Path)
	case AssertionDirExists:
		result = e.assertDirExists(assertion.Path)
	case AssertionDirNotExists:
		result = e.assertDirNotExists(assertion.Path)
	case AssertionFileContains:
		result = e.assertFileContains(assertion.Path, assertion.Contains)
	case AssertionFileNotContains:
		result = e.assertFileNotContains(assertion.Path, assertion.Contains)
	case AssertionFileMatches:
		result = e.assertFileMatches(assertion.Path, assertion.Pattern)
	case AssertionFileEquals:
		result = e.assertFileEquals(assertion.Path, assertion.Value)
	case AssertionOutputEquals:
		result = e.assertOutputEquals(assertion.Block, assertion.Output, assertion.Value)
	case AssertionOutputMatches:
		result = e.assertOutputMatches(assertion.Block, assertion.Output, assertion.Pattern)
	case AssertionOutputExists:
		result = e.assertOutputExists(assertion.Block, assertion.Output)
	case AssertionFilesGenerated:
		result = e.assertFilesGenerated(assertion.MinCount)
	case AssertionScript:
		result = e.assertScript(assertion.Command)
	default:
		result.Passed = false
		result.Message = fmt.Sprintf("unknown assertion type: %s", assertion.Type)
	}

	result.Type = assertion.Type
	return result
}

// resolvePath resolves a path relative to the output directory (workingDir + outputPath).
func (e *TestExecutor) resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	resolvedOutputPath := e.resolveOutputPath()
	return filepath.Join(resolvedOutputPath, path)
}

// assertFileExists checks that a file exists.
func (e *TestExecutor) assertFileExists(path string) AssertionResult {
	fullPath := e.resolvePath(path)
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return AssertionResult{
				Type:    AssertionFileExists,
				Passed:  false,
				Message: fmt.Sprintf("file does not exist: %s", path),
			}
		}
		return AssertionResult{
			Type:    AssertionFileExists,
			Passed:  false,
			Message: fmt.Sprintf("error checking file: %v", err),
		}
	}
	if info.IsDir() {
		return AssertionResult{
			Type:    AssertionFileExists,
			Passed:  false,
			Message: fmt.Sprintf("path exists but is a directory: %s", path),
		}
	}
	return AssertionResult{
		Type:   AssertionFileExists,
		Passed: true,
	}
}

// assertFileNotExists checks that a file does not exist.
func (e *TestExecutor) assertFileNotExists(path string) AssertionResult {
	fullPath := e.resolvePath(path)
	_, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return AssertionResult{
				Type:   AssertionFileNotExists,
				Passed: true,
			}
		}
		return AssertionResult{
			Type:    AssertionFileNotExists,
			Passed:  false,
			Message: fmt.Sprintf("error checking file: %v", err),
		}
	}
	return AssertionResult{
		Type:    AssertionFileNotExists,
		Passed:  false,
		Message: fmt.Sprintf("file exists but should not: %s", path),
	}
}

// assertDirExists checks that a directory exists.
func (e *TestExecutor) assertDirExists(path string) AssertionResult {
	fullPath := e.resolvePath(path)
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return AssertionResult{
				Type:    AssertionDirExists,
				Passed:  false,
				Message: fmt.Sprintf("directory does not exist: %s", path),
			}
		}
		return AssertionResult{
			Type:    AssertionDirExists,
			Passed:  false,
			Message: fmt.Sprintf("error checking directory: %v", err),
		}
	}
	if !info.IsDir() {
		return AssertionResult{
			Type:    AssertionDirExists,
			Passed:  false,
			Message: fmt.Sprintf("path exists but is not a directory: %s", path),
		}
	}
	return AssertionResult{
		Type:   AssertionDirExists,
		Passed: true,
	}
}

// assertDirNotExists checks that a directory does not exist.
func (e *TestExecutor) assertDirNotExists(path string) AssertionResult {
	fullPath := e.resolvePath(path)
	_, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return AssertionResult{
				Type:   AssertionDirNotExists,
				Passed: true,
			}
		}
		return AssertionResult{
			Type:    AssertionDirNotExists,
			Passed:  false,
			Message: fmt.Sprintf("error checking directory: %v", err),
		}
	}
	return AssertionResult{
		Type:    AssertionDirNotExists,
		Passed:  false,
		Message: fmt.Sprintf("directory exists but should not: %s", path),
	}
}

// assertFileContains checks that a file contains a substring.
func (e *TestExecutor) assertFileContains(path, contains string) AssertionResult {
	fullPath := e.resolvePath(path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return AssertionResult{
			Type:    AssertionFileContains,
			Passed:  false,
			Message: fmt.Sprintf("failed to read file: %v", err),
		}
	}

	if strings.Contains(string(content), contains) {
		return AssertionResult{
			Type:   AssertionFileContains,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionFileContains,
		Passed:  false,
		Message: fmt.Sprintf("file %s does not contain %q", path, contains),
	}
}

// assertFileNotContains checks that a file does not contain a substring.
func (e *TestExecutor) assertFileNotContains(path, contains string) AssertionResult {
	fullPath := e.resolvePath(path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return AssertionResult{
			Type:    AssertionFileNotContains,
			Passed:  false,
			Message: fmt.Sprintf("failed to read file: %v", err),
		}
	}

	if !strings.Contains(string(content), contains) {
		return AssertionResult{
			Type:   AssertionFileNotContains,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionFileNotContains,
		Passed:  false,
		Message: fmt.Sprintf("file %s contains %q but should not", path, contains),
	}
}

// assertFileMatches checks that a file matches a regex pattern.
func (e *TestExecutor) assertFileMatches(path, pattern string) AssertionResult {
	fullPath := e.resolvePath(path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return AssertionResult{
			Type:    AssertionFileMatches,
			Passed:  false,
			Message: fmt.Sprintf("failed to read file: %v", err),
		}
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return AssertionResult{
			Type:    AssertionFileMatches,
			Passed:  false,
			Message: fmt.Sprintf("invalid regex pattern: %v", err),
		}
	}

	if re.Match(content) {
		return AssertionResult{
			Type:   AssertionFileMatches,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionFileMatches,
		Passed:  false,
		Message: fmt.Sprintf("file %s does not match pattern %q", path, pattern),
	}
}

// assertFileEquals checks that a file content equals the expected value.
func (e *TestExecutor) assertFileEquals(path, expected string) AssertionResult {
	fullPath := e.resolvePath(path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return AssertionResult{
			Type:    AssertionFileEquals,
			Passed:  false,
			Message: fmt.Sprintf("failed to read file: %v", err),
		}
	}

	actual := string(content)
	if actual == expected {
		return AssertionResult{
			Type:   AssertionFileEquals,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionFileEquals,
		Passed:  false,
		Message: fmt.Sprintf("file %s content does not equal expected value", path),
	}
}

// assertOutputEquals checks that a block output equals the expected value.
func (e *TestExecutor) assertOutputEquals(blockID, outputName, expected string) AssertionResult {
	outputs, ok := e.blockOutputs[blockID]
	if !ok {
		return AssertionResult{
			Type:    AssertionOutputEquals,
			Passed:  false,
			Message: fmt.Sprintf("block %q has no outputs", blockID),
		}
	}

	actual, ok := outputs[outputName]
	if !ok {
		return AssertionResult{
			Type:    AssertionOutputEquals,
			Passed:  false,
			Message: fmt.Sprintf("block %q has no output %q", blockID, outputName),
		}
	}

	if actual == expected {
		return AssertionResult{
			Type:   AssertionOutputEquals,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionOutputEquals,
		Passed:  false,
		Message: fmt.Sprintf("output %s.%s = %q, expected %q", blockID, outputName, actual, expected),
	}
}

// assertOutputMatches checks that a block output matches a regex pattern.
func (e *TestExecutor) assertOutputMatches(blockID, outputName, pattern string) AssertionResult {
	outputs, ok := e.blockOutputs[blockID]
	if !ok {
		return AssertionResult{
			Type:    AssertionOutputMatches,
			Passed:  false,
			Message: fmt.Sprintf("block %q has no outputs", blockID),
		}
	}

	actual, ok := outputs[outputName]
	if !ok {
		return AssertionResult{
			Type:    AssertionOutputMatches,
			Passed:  false,
			Message: fmt.Sprintf("block %q has no output %q", blockID, outputName),
		}
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return AssertionResult{
			Type:    AssertionOutputMatches,
			Passed:  false,
			Message: fmt.Sprintf("invalid regex pattern: %v", err),
		}
	}

	if re.MatchString(actual) {
		return AssertionResult{
			Type:   AssertionOutputMatches,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionOutputMatches,
		Passed:  false,
		Message: fmt.Sprintf("output %s.%s = %q does not match pattern %q", blockID, outputName, actual, pattern),
	}
}

// assertOutputExists checks that a block output exists.
func (e *TestExecutor) assertOutputExists(blockID, outputName string) AssertionResult {
	outputs, ok := e.blockOutputs[blockID]
	if !ok {
		return AssertionResult{
			Type:    AssertionOutputExists,
			Passed:  false,
			Message: fmt.Sprintf("block %q has no outputs", blockID),
		}
	}

	if _, ok := outputs[outputName]; ok {
		return AssertionResult{
			Type:   AssertionOutputExists,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionOutputExists,
		Passed:  false,
		Message: fmt.Sprintf("block %q has no output %q", blockID, outputName),
	}
}

// assertFilesGenerated checks that at least minCount files were generated in the output directory.
func (e *TestExecutor) assertFilesGenerated(minCount int) AssertionResult {
	resolvedOutputPath := e.resolveOutputPath()
	count := 0
	err := filepath.Walk(resolvedOutputPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			count++
		}
		return nil
	})

	if err != nil {
		return AssertionResult{
			Type:    AssertionFilesGenerated,
			Passed:  false,
			Message: fmt.Sprintf("failed to walk output directory %q: %s", resolvedOutputPath, err.Error()),
		}
	}

	if count >= minCount {
		return AssertionResult{
			Type:   AssertionFilesGenerated,
			Passed: true,
		}
	}

	return AssertionResult{
		Type:    AssertionFilesGenerated,
		Passed:  false,
		Message: fmt.Sprintf("expected at least %d files generated, got %d", minCount, count),
	}
}

// assertScript runs a custom script command and checks for success.
func (e *TestExecutor) assertScript(command string) AssertionResult {
	duration := e.timeout
	if duration <= 0 {
		duration = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	cmd.Dir = e.resolveOutputPath()

	// Set environment from session
	execCtx, _ := e.session.ValidateToken(e.getSessionToken())
	if execCtx != nil {
		cmd.Env = execCtx.Env
	}

	err := cmd.Run()
	if err != nil {
		return AssertionResult{
			Type:    AssertionScript,
			Passed:  false,
			Message: fmt.Sprintf("script assertion failed: %v", err),
		}
	}

	return AssertionResult{
		Type:   AssertionScript,
		Passed: true,
	}
}
