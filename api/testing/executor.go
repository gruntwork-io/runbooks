package testing

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"runbooks/api"
)

// TestExecutor runs runbook tests in headless mode.
type TestExecutor struct {
	runbookPath string
	outputPath  string
	registry    *api.ExecutableRegistry
	session     *api.SessionManager
	timeout     time.Duration
	verbose     bool
	validator   *InputValidator

	// Track block outputs during test execution
	blockOutputs map[string]map[string]string // blockID -> outputName -> value

	// Test inputs from the current test case
	testInputs map[string]interface{} // inputsID.varName -> value
}

// ExecutorOption configures a TestExecutor.
type ExecutorOption func(*TestExecutor)

// WithTimeout sets the timeout for test execution.
func WithTimeout(d time.Duration) ExecutorOption {
	return func(e *TestExecutor) {
		e.timeout = d
	}
}

// WithVerbose enables verbose output.
func WithVerbose(v bool) ExecutorOption {
	return func(e *TestExecutor) {
		e.verbose = v
	}
}

// NewTestExecutor creates a new test executor for a runbook.
func NewTestExecutor(runbookPath, outputPath string, opts ...ExecutorOption) (*TestExecutor, error) {
	// Create executable registry to parse the runbook
	registry, err := api.NewExecutableRegistry(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to parse runbook: %w", err)
	}

	// Create session manager
	session := api.NewSessionManager()

	// Initialize session with runbook directory as working directory
	runbookDir := filepath.Dir(runbookPath)
	if _, err := session.CreateSession(runbookDir); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	// Create input validator
	validator, err := NewInputValidator(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create input validator: %w", err)
	}

	e := &TestExecutor{
		runbookPath:  runbookPath,
		outputPath:   outputPath,
		registry:     registry,
		session:      session,
		timeout:      5 * time.Minute,
		verbose:      false,
		validator:    validator,
		blockOutputs: make(map[string]map[string]string),
	}

	for _, opt := range opts {
		opt(e)
	}

	return e, nil
}

// RunTest runs a single test case and returns the result.
func (e *TestExecutor) RunTest(tc TestCase) TestResult {
	start := time.Now()

	result := TestResult{
		TestCase: tc.Name,
		Status:   TestPassed,
	}

	// Resolve test inputs (generate fuzz values where needed)
	resolvedInputs, err := ResolveInputs(tc.Inputs)
	if err != nil {
		result.Status = TestFailed
		result.Error = fmt.Sprintf("failed to resolve inputs: %v", err)
		result.Duration = time.Since(start)
		return result
	}

	// Validate resolved inputs against boilerplate schemas
	if validationErrors := e.validator.Validate(resolvedInputs); len(validationErrors) > 0 {
		result.Status = TestFailed
		result.Error = validationErrors.Error()
		result.Duration = time.Since(start)
		return result
	}

	e.testInputs = resolvedInputs

	// Reset block outputs for this test
	e.blockOutputs = make(map[string]map[string]string)

	// Determine which blocks to execute
	blocks := e.determineBlocks(tc)

	// Execute each block
	for _, step := range blocks {
		stepResult := e.executeStep(step)
		result.StepResults = append(result.StepResults, stepResult)

		// Check if step passed
		if !stepResult.Passed {
			result.Status = TestFailed
			result.Error = fmt.Sprintf("step %q failed: %s", step.Block, stepResult.Error)
			// Continue to cleanup but don't run more steps
			break
		}

		// Run per-step assertions
		for _, assertion := range step.Assertions {
			ar := e.runAssertion(assertion)
			stepResult.AssertionResults = append(stepResult.AssertionResults, ar)
			if !ar.Passed {
				result.Status = TestFailed
				result.Error = fmt.Sprintf("step %q assertion failed: %s", step.Block, ar.Message)
				break
			}
		}

		if result.Status == TestFailed {
			break
		}
	}

	// Run post-test assertions (only if no step failures)
	if result.Status != TestFailed {
		for _, assertion := range tc.Assertions {
			ar := e.runAssertion(assertion)
			result.Assertions = append(result.Assertions, ar)
			if !ar.Passed {
				result.Status = TestFailed
				result.Error = fmt.Sprintf("assertion failed: %s", ar.Message)
				break
			}
		}
	}

	// Run cleanup (always, even on failure)
	for _, cleanup := range tc.Cleanup {
		if err := e.runCleanup(cleanup); err != nil {
			slog.Warn("Cleanup action failed", "error", err)
		}
	}

	result.Duration = time.Since(start)
	return result
}

// determineBlocks returns the list of steps to execute.
// If steps is empty, returns all executable blocks in document order.
func (e *TestExecutor) determineBlocks(tc TestCase) []TestStep {
	if len(tc.Steps) > 0 {
		return tc.Steps
	}

	// No steps specified - run all blocks in registry order
	// The registry doesn't preserve order, so we return executables by component ID
	executables := e.registry.GetAllExecutables()
	steps := make([]TestStep, 0, len(executables))
	for _, exec := range executables {
		steps = append(steps, TestStep{
			Block:  exec.ComponentID,
			Expect: StatusSuccess,
		})
	}
	return steps
}

// executeStep runs a single block and returns the result.
func (e *TestExecutor) executeStep(step TestStep) StepResult {
	start := time.Now()

	result := StepResult{
		Block:          step.Block,
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Handle skip expectation
	if step.Expect == StatusSkip {
		result.Passed = true
		result.ActualStatus = "skipped"
		result.Duration = time.Since(start)
		return result
	}

	// Find the executable for this block
	// Note: We need to look up by component ID and get the full executable with script content
	var executable *api.Executable
	for _, exec := range e.registry.GetAllExecutables() {
		if exec.ComponentID == step.Block {
			// GetAllExecutables() strips script content for security
			// Use GetExecutable() to get the full executable with content
			fullExec, ok := e.registry.GetExecutable(exec.ID)
			if ok {
				executable = fullExec
			}
			break
		}
	}

	if executable == nil {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("block %q not found in runbook", step.Block)
		result.Duration = time.Since(start)
		return result
	}

	// Handle blocked expectation - check for missing dependencies
	if step.Expect == StatusBlocked {
		// Check if the required outputs exist
		missingOutputs := e.checkMissingOutputs(step.MissingOutputs)
		if len(missingOutputs) > 0 {
			result.Passed = true
			result.ActualStatus = "blocked"
			result.Error = fmt.Sprintf("blocked due to missing outputs: %v", missingOutputs)
		} else {
			result.Passed = false
			result.ActualStatus = "not_blocked"
			result.Error = "expected block to be blocked but all dependencies are satisfied"
		}
		result.Duration = time.Since(start)
		return result
	}

	// Execute the block
	status, exitCode, outputs, err := e.executeBlock(executable)
	result.ActualStatus = status
	result.ExitCode = exitCode
	result.Outputs = outputs

	// Store outputs for later assertions
	if len(outputs) > 0 {
		e.blockOutputs[step.Block] = outputs
	}

	if err != nil {
		result.Error = err.Error()
	}

	// Check if result matches expected status
	result.Passed = e.matchesExpectedStatus(step.Expect, status, exitCode)

	result.Duration = time.Since(start)
	return result
}

// checkMissingOutputs checks which expected outputs are missing.
func (e *TestExecutor) checkMissingOutputs(expected []string) []string {
	var missing []string
	for _, path := range expected {
		// Parse paths like "_blocks.create_account.outputs.account_id"
		parts := strings.Split(path, ".")
		if len(parts) >= 4 && parts[0] == "_blocks" && parts[2] == "outputs" {
			blockID := parts[1]
			outputName := parts[3]
			if e.blockOutputs[blockID] == nil || e.blockOutputs[blockID][outputName] == "" {
				missing = append(missing, path)
			}
		}
	}
	return missing
}

// executeBlock executes a single block and returns status, exit code, outputs, and error.
func (e *TestExecutor) executeBlock(executable *api.Executable) (string, int, map[string]string, error) {
	// Get session context
	execCtx, valid := e.session.ValidateToken(e.getSessionToken())
	if !valid {
		return "error", -1, nil, fmt.Errorf("invalid session")
	}

	// Prepare script content
	scriptContent := executable.ScriptContent

	// Check for missing block output dependencies before rendering
	// This provides a clearer error message than the Go template "map has no entry for key" error
	if missing := e.findMissingOutputDependencies(scriptContent); len(missing) > 0 {
		return "error", -1, nil, fmt.Errorf("block references outputs that haven't been produced yet: %s. "+
			"Make sure the blocks that produce these outputs run before this block in your test steps",
			strings.Join(missing, ", "))
	}

	// Always render template variables in test mode
	// Scripts may reference _blocks outputs which aren't detected by TemplateVarNames
	vars := e.buildTemplateVars()
	rendered, err := api.RenderBoilerplateContent(scriptContent, vars)
	if err != nil {
		return "error", -1, nil, fmt.Errorf("failed to render template: %w", err)
	}
	scriptContent = rendered

	// Create temp files for outputs and file capture
	outputFile, err := os.CreateTemp("", "runbook-output-*.txt")
	if err != nil {
		return "error", -1, nil, fmt.Errorf("failed to create output file: %w", err)
	}
	outputFilePath := outputFile.Name()
	outputFile.Close()
	defer os.Remove(outputFilePath)

	filesDir, err := os.MkdirTemp("", "runbook-files-*")
	if err != nil {
		return "error", -1, nil, fmt.Errorf("failed to create files directory: %w", err)
	}
	defer os.RemoveAll(filesDir)

	// Create temporary script file
	scriptFile, err := os.CreateTemp("", "runbook-script-*.sh")
	if err != nil {
		return "error", -1, nil, fmt.Errorf("failed to create script file: %w", err)
	}
	scriptPath := scriptFile.Name()
	scriptFile.WriteString(scriptContent)
	scriptFile.Close()
	os.Chmod(scriptPath, 0700)
	defer os.Remove(scriptPath)

	// Detect interpreter
	interpreter, args := detectInterpreter(scriptContent, executable.Language)

	// Create command
	ctx, cancel := context.WithTimeout(context.Background(), e.timeout)
	defer cancel()

	cmdArgs := append(args, scriptPath)
	cmd := exec.CommandContext(ctx, interpreter, cmdArgs...)

	// Set environment
	cmd.Env = execCtx.Env
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_OUTPUT=%s", outputFilePath))
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_FILES=%s", filesDir))

	// Set working directory
	if execCtx.WorkDir != "" {
		cmd.Dir = execCtx.WorkDir
	}

	// Capture output
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	// Start command
	if err := cmd.Start(); err != nil {
		return "error", -1, nil, fmt.Errorf("failed to start script: %w", err)
	}

	// Read output
	go e.streamOutput(stdout)
	go e.streamOutput(stderr)

	// Wait for completion
	waitErr := cmd.Wait()

	// Determine status
	exitCode := 0
	status := "success"
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			return "timeout", -1, nil, fmt.Errorf("script execution timed out")
		} else {
			exitCode = 1
		}
		switch exitCode {
		case 0:
			status = "success"
		case 2:
			status = "warn"
		default:
			status = "fail"
		}
	}

	// Parse outputs
	outputs := make(map[string]string)
	if status == "success" || status == "warn" {
		outputs, _ = parseBlockOutputs(outputFilePath)
	}

	// Copy captured files to output directory
	if status == "success" || status == "warn" {
		if err := e.captureFiles(filesDir); err != nil {
			slog.Warn("Failed to capture files", "error", err)
		}
	}

	return status, exitCode, outputs, nil
}

// streamOutput reads from a pipe and prints if verbose.
func (e *TestExecutor) streamOutput(r io.ReadCloser) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		if e.verbose {
			fmt.Println(scanner.Text())
		}
	}
}

// matchesExpectedStatus checks if actual status matches expected.
func (e *TestExecutor) matchesExpectedStatus(expected ExpectedStatus, actual string, exitCode int) bool {
	switch expected {
	case StatusSuccess:
		return actual == "success"
	case StatusFail:
		return actual == "fail"
	case StatusWarn:
		return actual == "warn"
	case StatusBlocked:
		return actual == "blocked"
	case StatusSkip:
		return actual == "skipped"
	default:
		return false
	}
}

// getSessionToken returns a valid session token.
func (e *TestExecutor) getSessionToken() string {
	// Get the first valid token from the session
	session, ok := e.session.GetSession()
	if !ok {
		return ""
	}
	for token := range session.ValidTokens {
		return token
	}
	return ""
}

// findMissingOutputDependencies checks the script content for {{ ._blocks.x.outputs.y }} references
// and returns a list of any that aren't available in blockOutputs.
func (e *TestExecutor) findMissingOutputDependencies(scriptContent string) []string {
	dependencies := api.ExtractOutputDependenciesFromContent(scriptContent)
	var missing []string

	for _, dep := range dependencies {
		// Normalize block ID (hyphens -> underscores) to match how we store outputs
		normalizedBlockID := strings.ReplaceAll(dep.BlockID, "-", "_")

		// Check if this block's output exists
		blockOutputs, blockExists := e.blockOutputs[dep.BlockID]
		if !blockExists {
			// Also check with normalized ID in case it was stored that way
			blockOutputs, blockExists = e.blockOutputs[normalizedBlockID]
		}

		if !blockExists {
			missing = append(missing, fmt.Sprintf("{{ ._blocks.%s.outputs.%s }} (block %q hasn't run yet)",
				dep.BlockID, dep.OutputName, dep.BlockID))
		} else if _, outputExists := blockOutputs[dep.OutputName]; !outputExists {
			missing = append(missing, fmt.Sprintf("{{ ._blocks.%s.outputs.%s }} (block %q ran but didn't produce output %q)",
				dep.BlockID, dep.OutputName, dep.BlockID, dep.OutputName))
		}
	}

	return missing
}

// buildTemplateVars builds template variables including test inputs and block outputs.
func (e *TestExecutor) buildTemplateVars() map[string]interface{} {
	vars := make(map[string]interface{})

	// Add test inputs (format: inputsID.varName -> value)
	// These become top-level template variables like {{ .varName }}
	for key, value := range e.testInputs {
		// Parse "inputsID.varName" format
		parts := strings.SplitN(key, ".", 2)
		if len(parts) == 2 {
			varName := parts[1]
			vars[varName] = value
		}
	}

	// Add block outputs (convert hyphens to underscores for Go template compatibility)
	blocks := make(map[string]interface{})
	for blockID, outputs := range e.blockOutputs {
		// Convert block ID hyphens to underscores for template access
		templateBlockID := strings.ReplaceAll(blockID, "-", "_")
		blockData := map[string]interface{}{
			"outputs": outputs,
		}
		blocks[templateBlockID] = blockData
	}
	if len(blocks) > 0 {
		vars["_blocks"] = blocks
	}

	return vars
}

// captureFiles copies files from the capture directory to the output path.
func (e *TestExecutor) captureFiles(srcDir string) error {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}

	// Create output directory if needed
	if err := os.MkdirAll(e.outputPath, 0755); err != nil {
		return err
	}

	return filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == srcDir {
			return nil
		}

		relPath, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		dstPath := filepath.Join(e.outputPath, relPath)

		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}

		return copyFile(path, dstPath)
	})
}

// copyFile copies a file from src to dst.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	dstFile, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// parseBlockOutputs reads the output file and parses key=value pairs.
func parseBlockOutputs(filePath string) (map[string]string, error) {
	outputs := make(map[string]string)

	content, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return outputs, nil
		}
		return nil, err
	}

	lines := strings.Split(string(content), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		idx := strings.Index(line, "=")
		if idx == -1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		value := line[idx+1:]
		outputs[key] = value
	}

	return outputs, nil
}

// detectInterpreter detects the interpreter from shebang or uses default.
func detectInterpreter(script string, providedLang string) (string, []string) {
	if providedLang != "" {
		return providedLang, []string{}
	}

	lines := strings.Split(script, "\n")
	if len(lines) > 0 && strings.HasPrefix(lines[0], "#!") {
		shebang := strings.TrimSpace(lines[0][2:])
		if strings.Contains(shebang, "/env ") {
			parts := strings.Fields(shebang)
			if len(parts) >= 2 {
				return parts[1], parts[2:]
			}
		} else {
			parts := strings.Fields(shebang)
			if len(parts) >= 1 {
				interpreter := parts[0]
				if idx := strings.LastIndex(interpreter, "/"); idx != -1 {
					interpreter = interpreter[idx+1:]
				}
				return interpreter, parts[1:]
			}
		}
	}

	return "bash", []string{}
}

// runCleanup runs a single cleanup action.
func (e *TestExecutor) runCleanup(action CleanupAction) error {
	var script string

	if action.Command != "" {
		script = action.Command
	} else if action.Path != "" {
		runbookDir := filepath.Dir(e.runbookPath)
		scriptPath := filepath.Join(runbookDir, action.Path)
		content, err := os.ReadFile(scriptPath)
		if err != nil {
			return fmt.Errorf("failed to read cleanup script: %w", err)
		}
		script = string(content)
	} else {
		return fmt.Errorf("cleanup action must have command or path")
	}

	// Create temp script
	tmpFile, err := os.CreateTemp("", "runbook-cleanup-*.sh")
	if err != nil {
		return err
	}
	tmpFile.WriteString(script)
	tmpFile.Close()
	os.Chmod(tmpFile.Name(), 0700)
	defer os.Remove(tmpFile.Name())

	// Run cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", tmpFile.Name())
	execCtx, _ := e.session.ValidateToken(e.getSessionToken())
	if execCtx != nil {
		cmd.Env = execCtx.Env
		cmd.Dir = execCtx.WorkDir
	}

	return cmd.Run()
}

// Close cleans up the executor.
func (e *TestExecutor) Close() {
	e.session.DeleteSession()
}

// GetBlockOutputs returns all captured block outputs.
func (e *TestExecutor) GetBlockOutputs() map[string]map[string]string {
	return e.blockOutputs
}

// SetInputs sets input values for template rendering.
// This is called before running tests to provide input values.
func (e *TestExecutor) SetInputs(inputs map[string]interface{}) {
	// Store inputs for use in template rendering
	// For now, inputs are handled through environment variables or direct template vars
	// This will be enhanced when we add full input support
}
