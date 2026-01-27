package testing

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

	// Parsed TemplateInline blocks from the runbook
	templateInlines map[string]*TemplateInlineBlock // blockID -> block info

	// Parsed Template blocks from the runbook
	templates map[string]*TemplateBlock // blockID -> block info
}

// TemplateInlineBlock holds information about a TemplateInline block parsed from the runbook
type TemplateInlineBlock struct {
	ID         string
	Content    string // The template content (between the tags)
	OutputPath string // The outputPath prop
	InputsID   string // The inputsId prop (may be empty)
}

// TemplateBlock holds information about a Template block parsed from the runbook
type TemplateBlock struct {
	ID           string
	TemplatePath string // The path prop (relative to runbook directory)
	InputsID     string // The inputsId prop (may be empty)
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

	// Create input validator (config errors are reported during test execution, not here)
	validator, err := NewInputValidator(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create input validator: %w", err)
	}

	// Parse TemplateInline blocks from the runbook
	templateInlines, err := parseTemplateInlineBlocks(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to parse TemplateInline blocks: %w", err)
	}

	// Parse Template blocks from the runbook
	templates, err := parseTemplateBlocks(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Template blocks: %w", err)
	}

	e := &TestExecutor{
		runbookPath:     runbookPath,
		outputPath:      outputPath,
		registry:        registry,
		session:         session,
		timeout:         5 * time.Minute,
		verbose:         false,
		validator:       validator,
		blockOutputs:    make(map[string]map[string]string),
		templateInlines: templateInlines,
		templates:       templates,
	}

	for _, opt := range opts {
		opt(e)
	}

	return e, nil
}

// parseTemplateInlineBlocks parses TemplateInline blocks from a runbook MDX file
func parseTemplateInlineBlocks(runbookPath string) (map[string]*TemplateInlineBlock, error) {
	content, err := os.ReadFile(runbookPath)
	if err != nil {
		return nil, err
	}

	blocks := make(map[string]*TemplateInlineBlock)
	contentStr := string(content)

	// Match TemplateInline blocks with their content
	// <TemplateInline outputPath="..." inputsId="...">...</TemplateInline>
	re := regexp.MustCompile(`<TemplateInline\s+([^>]*?)>([\s\S]*?)</TemplateInline>`)
	matches := re.FindAllStringSubmatch(contentStr, -1)

	templateCount := 0
	for _, match := range matches {
		props := match[1]
		templateContent := match[2]

		// Extract props
		outputPath := extractMDXPropValue(props, "outputPath")
		inputsID := extractMDXPropValue(props, "inputsId")

		// Generate ID from outputPath
		id := generateTemplateInlineID(outputPath)
		if id == "" {
			templateCount++
			id = fmt.Sprintf("template-inline-%d", templateCount)
		}

		// Extract the actual template content from code fence if present
		templateContent = extractTemplateContent(templateContent)

		blocks[id] = &TemplateInlineBlock{
			ID:         id,
			Content:    templateContent,
			OutputPath: outputPath,
			InputsID:   inputsID,
		}
	}

	return blocks, nil
}

// parseTemplateBlocks parses Template blocks from a runbook MDX file
func parseTemplateBlocks(runbookPath string) (map[string]*TemplateBlock, error) {
	content, err := os.ReadFile(runbookPath)
	if err != nil {
		return nil, err
	}

	blocks := make(map[string]*TemplateBlock)
	contentStr := string(content)

	// Match Template blocks (self-closing or with closing tag)
	// <Template id="..." path="..." />
	// <Template id="..." path="..."></Template>
	re := regexp.MustCompile(`<Template\s+([^>]*?)(?:/>|>(?:</Template>)?)`)
	matches := re.FindAllStringSubmatch(contentStr, -1)

	for _, match := range matches {
		props := match[1]

		// Extract props
		id := extractMDXPropValue(props, "id")
		templatePath := extractMDXPropValue(props, "path")
		inputsID := extractMDXPropValue(props, "inputsId")

		if id == "" || templatePath == "" {
			continue // Skip invalid blocks
		}

		blocks[id] = &TemplateBlock{
			ID:           id,
			TemplatePath: templatePath,
			InputsID:     inputsID,
		}
	}

	return blocks, nil
}

// extractMDXPropValue extracts a prop value from an MDX props string
func extractMDXPropValue(props, propName string) string {
	patterns := []string{
		fmt.Sprintf(`%s="([^"]*)"`, propName),
		fmt.Sprintf(`%s='([^']*)'`, propName),
		fmt.Sprintf(`%s=\{`+"`([^`]*)`"+`\}`, propName),
		fmt.Sprintf(`%s=\{"([^"]*)"\}`, propName),
		fmt.Sprintf(`%s=\{'([^']*)'\}`, propName),
	}

	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		if match := re.FindStringSubmatch(props); len(match) > 1 {
			return match[1]
		}
	}

	return ""
}

// extractTemplateContent extracts template content from a code fence
func extractTemplateContent(content string) string {
	// Look for ```language ... ``` pattern
	codeFenceRe := regexp.MustCompile("(?s)```[a-zA-Z]*\\s*\\n(.+?)```")
	if match := codeFenceRe.FindStringSubmatch(content); len(match) > 1 {
		return match[1]
	}
	// Return trimmed content if no code fence
	return strings.TrimSpace(content)
}

// PrintRunbookHeader prints a prominent header for the runbook being tested.
// Call this before running tests in verbose mode.
func (e *TestExecutor) PrintRunbookHeader() {
	if !e.verbose {
		return
	}

	relPath, _ := filepath.Rel(".", e.runbookPath)
	if relPath == "" {
		relPath = e.runbookPath
	}

	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════════════════════")
	fmt.Printf("║ RUNBOOK: %s\n", relPath)
	fmt.Println("╚══════════════════════════════════════════════════════════════════════════════")
}

// PrintTestHeader prints a header for an individual test case.
func (e *TestExecutor) PrintTestHeader(testName string) {
	if !e.verbose {
		return
	}
	fmt.Printf("\n── Test: %s ──\n", testName)
}

// getRegistryWarningForBlock searches warnings for one matching the given block ID.
func (e *TestExecutor) getRegistryWarningForBlock(warnings []string, blockID string) string {
	blockPattern := fmt.Sprintf(`id="%s"`, blockID)
	for _, warning := range warnings {
		if strings.Contains(warning, blockPattern) {
			return warning
		}
	}
	return ""
}

// lowercaseFirst returns the string with the first character lowercased.
func lowercaseFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// RunTest runs a single test case and returns the result.
// Blocks are processed in document order, with validation and execution happening per-block.
func (e *TestExecutor) RunTest(tc TestCase) TestResult {
	start := time.Now()

	result := TestResult{
		TestCase: tc.Name,
		Status:   TestPassed,
	}

	// 1. Generate test values from fuzz specs/literals (upfront, before any block processing)
	resolvedInputs, err := ResolveTestConfig(tc.Inputs)
	if err != nil {
		result.Status = TestFailed
		result.Error = fmt.Sprintf("failed to resolve test config: %v", err)
		result.Duration = time.Since(start)
		return result
	}

	// 2. Validate test values against boilerplate schemas
	if validationErrors := e.validator.ValidateInputValues(resolvedInputs); len(validationErrors) > 0 {
		result.Status = TestFailed
		result.Error = validationErrors.Error()
		result.Duration = time.Since(start)
		return result
	}

	e.testInputs = resolvedInputs

	// Reset block outputs for this test
	e.blockOutputs = make(map[string]map[string]string)

	// 3. Get all components in document order
	allComponents := e.validator.GetComponents()

	// 4. Build maps for step handling
	expectsConfigError := make(map[string]bool)
	stepsToExecute := make(map[string]TestStep)
	hasExplicitSteps := len(tc.Steps) > 0

	for _, step := range tc.Steps {
		if step.Expect == StatusConfigError {
			expectsConfigError[step.Block] = true
		}
		stepsToExecute[step.Block] = step
	}

	// Get registry warnings for Check/Command validation
	registryWarnings := e.registry.GetWarnings()

	// 5. Process each block in document order
	for _, comp := range allComponents {
		stepResult := e.processBlock(comp, stepsToExecute, expectsConfigError, registryWarnings, hasExplicitSteps)
		result.StepResults = append(result.StepResults, stepResult)

		// Check if we should stop execution
		if !stepResult.Passed {
			// Determine if this block was requested (in steps list or no explicit steps)
			_, isRequested := stepsToExecute[comp.ID]
			if !hasExplicitSteps || isRequested {
				// Unexpected error in a requested block - stop execution
				result.Status = TestFailed
				result.Error = e.formatBlockErrorFromResult(comp, stepResult)
				break
			}
			// Error in non-requested block - continue but mark as failed
			// (This shouldn't happen often since non-requested blocks aren't executed)
		}

		// Run per-step assertions if this was an executed step
		if step, ok := stepsToExecute[comp.ID]; ok && stepResult.Passed {
			for _, assertion := range step.Assertions {
				ar := e.runAssertion(assertion)
				stepResult.AssertionResults = append(stepResult.AssertionResults, ar)
				if !ar.Passed {
					result.Status = TestFailed
					result.Error = fmt.Sprintf("%s block %q assertion failed: %s", comp.Type, comp.ID, ar.Message)
					break
				}
			}

			if result.Status == TestFailed {
				break
			}
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

// processBlock handles validation and execution for a single block.
// It validates configuration, and for executable blocks, executes them if they're in the steps list.
func (e *TestExecutor) processBlock(
	comp api.ParsedComponent,
	stepsToExecute map[string]TestStep,
	expectsConfigError map[string]bool,
	registryWarnings []string,
	hasExplicitSteps bool,
) StepResult {
	start := time.Now()

	// Determine if this block should be executed
	step, shouldExecute := stepsToExecute[comp.ID]
	if !hasExplicitSteps {
		// No explicit steps - execute all executable blocks
		shouldExecute = comp.Type != "Inputs" // Inputs blocks are validation-only
		step = TestStep{Block: comp.ID, Expect: StatusSuccess}
	}

	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(comp.Type), comp.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// 1. Check for configuration errors
	configError := e.getConfigErrorForComponent(comp, registryWarnings)

	// 2. Handle config errors
	if configError != "" {
		result.ActualStatus = "config_error"
		result.Error = configError

		// Determine if this block was requested
		_, isRequested := stepsToExecute[comp.ID]
		isRequested = isRequested || !hasExplicitSteps // All blocks are "requested" when no explicit steps

		if expectsConfigError[comp.ID] {
			// Check error_contains if specified
			if step.ErrorContains != "" && !strings.Contains(strings.ToLower(configError), strings.ToLower(step.ErrorContains)) {
				// Error doesn't contain expected text
				result.Passed = false
				if e.verbose {
					fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
					fmt.Printf("--- Result: ✗ config_error (wrong message) ---\n")
					fmt.Printf("  Expected error containing: %s\n", step.ErrorContains)
					fmt.Printf("  Actual error: %s\n", configError)
					result.ErrorDisplayed = true
				}
			} else {
				// Expected config error - pass
				result.Passed = true
				if e.verbose {
					fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
					fmt.Printf("--- Result: ✓ config_error (expected) ---\n")
					fmt.Printf("  Error: %s\n", configError)
					result.ErrorDisplayed = true
				}
			}
		} else if !isRequested {
			// Config error in non-requested block - show as warning but don't fail
			result.Passed = true // Don't fail the test for non-requested blocks
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
				fmt.Printf("--- Config: ⚠ error (not in steps) ---\n")
				fmt.Printf("  Error: %s\n", configError)
				result.ErrorDisplayed = true
			}
		} else {
			// Unexpected config error in requested block - fail
			result.Passed = false
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
				fmt.Printf("--- Result: ✗ config_error ---\n")
				fmt.Printf("  Error: %s\n", configError)
				result.ErrorDisplayed = true
			}
		}
		result.Duration = time.Since(start)
		return result
	}

	// 3. For Inputs blocks: validation-only, show "Config: valid"
	if comp.Type == "Inputs" {
		result.ActualStatus = "valid"
		result.Passed = true
		if e.verbose {
			fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
			fmt.Printf("--- Config: ✓ valid ---\n")
		}
		result.Duration = time.Since(start)
		return result
	}

	// 4. For executable blocks: execute if requested
	if !shouldExecute {
		// Not in steps list - skip execution (config was already validated)
		result.ActualStatus = "skipped"
		result.Passed = true
		// Don't print anything for skipped blocks in verbose mode
		result.Duration = time.Since(start)
		return result
	}

	// 5. Execute the block
	return e.executeBlockForComponent(comp, step, start)
}

// getConfigErrorForComponent returns any configuration error for the component.
func (e *TestExecutor) getConfigErrorForComponent(comp api.ParsedComponent, registryWarnings []string) string {
	switch comp.Type {
	case "Check", "Command":
		// For Check/Command, check both registry warnings and validator config errors.
		// Registry warnings cover file-not-found errors; validator covers structural errors like missing ID.
		if warning := e.getRegistryWarningForBlock(registryWarnings, comp.ID); warning != "" {
			return warning
		}
		return e.validator.GetConfigError(comp.Type, comp.ID)
	case "Inputs", "Template", "TemplateInline":
		// For Inputs/Template/TemplateInline, get errors from InputValidator
		return e.validator.GetConfigError(comp.Type, comp.ID)
	default:
		// Unknown component type
		return fmt.Sprintf("unsupported component type %q", comp.Type)
	}
}

// executeBlockForComponent executes a single block and returns the result.
func (e *TestExecutor) executeBlockForComponent(comp api.ParsedComponent, step TestStep, start time.Time) StepResult {
	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(comp.Type), comp.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Print block header if verbose
	if e.verbose {
		fmt.Printf("\n=== %s: %s ===\n", comp.Type, comp.ID)
	}

	// Handle skip expectation
	if step.Expect == StatusSkip {
		result.Passed = true
		result.ActualStatus = "skipped"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Println("  (skipped)")
		}
		return result
	}

	// Handle config_error expectation - but config errors were already checked above
	// If we reach here with config_error expectation but no config error, it's an error
	if step.Expect == StatusConfigError {
		result.Passed = false
		result.ActualStatus = "no_config_error"
		result.Error = "expected config_error but component configuration is valid"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ no_config_error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// Execute based on component type
	switch comp.Type {
	case "TemplateInline":
		if templateInline, ok := e.templateInlines[comp.ID]; ok {
			return e.executeTemplateInline(step, templateInline, start)
		}
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("TemplateInline block %q not found", comp.ID)
		result.Duration = time.Since(start)
		return result

	case "Template":
		if template, ok := e.templates[comp.ID]; ok {
			return e.executeTemplate(step, template, start)
		}
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("Template block %q not found", comp.ID)
		result.Duration = time.Since(start)
		return result

	case "Check", "Command":
		// Find the executable for this block
		var executable *api.Executable
		for _, exec := range e.registry.GetAllExecutables() {
			if exec.ComponentID == comp.ID {
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
			result.Error = fmt.Sprintf("block %q not found in runbook", comp.ID)
			result.Duration = time.Since(start)
			if e.verbose {
				fmt.Printf("  Error: %s\n", result.Error)
			}
			return result
		}

		// Handle blocked expectation
		if step.Expect == StatusBlocked {
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
			if e.verbose {
				fmt.Printf("  Status: %s\n", result.ActualStatus)
			}
			return result
		}

		// Execute the block
		status, exitCode, outputs, logs, err := e.executeBlock(executable)
		result.ActualStatus = status
		result.ExitCode = exitCode
		result.Outputs = outputs
		result.Logs = logs

		if e.verbose {
			e.printBlockOutput(comp.ID, logs, outputs, status, err)
		}

		// Store outputs for later assertions
		if len(outputs) > 0 {
			e.blockOutputs[comp.ID] = outputs
		}

		if err != nil {
			result.Error = err.Error()
		}

		// Check if result matches expected status
		result.Passed = e.matchesExpectedStatus(step.Expect, status, exitCode)
		result.Duration = time.Since(start)
		return result

	default:
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("unsupported component type %q for execution", comp.Type)
		result.Duration = time.Since(start)
		return result
	}
}

// formatBlockErrorFromResult formats an error message for a failed block.
func (e *TestExecutor) formatBlockErrorFromResult(comp api.ParsedComponent, stepResult StepResult) string {
	if stepResult.ErrorDisplayed {
		// Error was already shown in verbose mode
		return fmt.Sprintf("%s block '%s' failed (see details above)", comp.Type, comp.ID)
	}
	if stepResult.Error != "" {
		return fmt.Sprintf("%s block '%s': %s", comp.Type, comp.ID, stepResult.Error)
	}
	return fmt.Sprintf("%s block '%s' failed with status: %s", comp.Type, comp.ID, stepResult.ActualStatus)
}

// executeTemplateInline renders a TemplateInline block and returns the result.
func (e *TestExecutor) executeTemplateInline(step TestStep, block *TemplateInlineBlock, start time.Time) StepResult {
	result := StepResult{
		Block:          step.Block,
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Check for missing output dependencies before rendering
	if missing := e.findMissingOutputDependencies(block.Content); len(missing) > 0 {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("template references outputs that haven't been produced yet: %s",
			strings.Join(missing, ", "))
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Println("--- Template Content ---")
			// Show first few lines of template
			lines := strings.Split(block.Content, "\n")
			for i, line := range lines {
				if i >= 5 {
					fmt.Println("  ...")
					break
				}
				fmt.Printf("  %s\n", line)
			}
			fmt.Printf("--- Result: ✗ error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// Build template variables
	vars := e.buildTemplateVars()

	// Render the template
	rendered, err := api.RenderBoilerplateContent(block.Content, vars)
	if err != nil {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("failed to render template: %v", err)
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// Success - template rendered
	result.Passed = e.matchesExpectedStatus(step.Expect, "success", 0)
	result.ActualStatus = "success"
	result.Logs = rendered
	result.Duration = time.Since(start)

	if e.verbose {
		fmt.Println("--- Rendered Output ---")
		// Show rendered content (truncate if too long)
		lines := strings.Split(rendered, "\n")
		for i, line := range lines {
			if i >= 20 {
				fmt.Printf("  ... (%d more lines)\n", len(lines)-20)
				break
			}
			fmt.Printf("  %s\n", line)
		}
		if block.OutputPath != "" {
			fmt.Printf("--- Output Path: %s ---\n", block.OutputPath)
		}
		fmt.Printf("--- Result: ✓ success ---\n")
	}

	return result
}

// executeTemplate renders a Template block and returns the result.
func (e *TestExecutor) executeTemplate(step TestStep, block *TemplateBlock, start time.Time) StepResult {
	result := StepResult{
		Block:          step.Block,
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Resolve template path relative to runbook directory
	runbookDir := filepath.Dir(e.runbookPath)
	templatePath := filepath.Join(runbookDir, block.TemplatePath)

	// Build template variables from test inputs
	vars := e.buildTemplateVars()

	// Determine output directory - use "generated" subdirectory in the test output path
	// This keeps test artifacts in the temp directory for automatic cleanup
	outputDir := filepath.Join(e.outputPath, "generated")

	// Create output directory if it doesn't exist
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("failed to create output directory: %v", err)
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	if e.verbose {
		fmt.Printf("--- Rendering Template ---\n")
		fmt.Printf("  Template: %s\n", block.TemplatePath)
		fmt.Printf("  Output: %s\n", outputDir)
	}

	// Render the template using boilerplate
	err := api.RenderBoilerplateTemplate(templatePath, outputDir, vars)
	if err != nil {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("failed to render template: %v", err)
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// List generated files for verbose output
	var generatedFiles []string
	filepath.Walk(outputDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		relPath, _ := filepath.Rel(outputDir, path)
		generatedFiles = append(generatedFiles, relPath)
		return nil
	})

	// Success - template rendered
	result.Passed = e.matchesExpectedStatus(step.Expect, "success", 0)
	result.ActualStatus = "success"
	result.Duration = time.Since(start)

	if e.verbose {
		if len(generatedFiles) > 0 {
			fmt.Printf("--- Generated Files ---\n")
			for _, f := range generatedFiles {
				fmt.Printf("  %s\n", f)
			}
		}
		fmt.Printf("--- Result: ✓ success ---\n")
	}

	return result
}

// printBlockOutput prints organized output for a block execution.
func (e *TestExecutor) printBlockOutput(blockID string, logs string, outputs map[string]string, status string, err error) {
	// Print logs if any
	if logs != "" {
		fmt.Println("--- Script Output ---")
		// Indent each line for readability
		for _, line := range strings.Split(strings.TrimRight(logs, "\n"), "\n") {
			fmt.Printf("  %s\n", line)
		}
	}

	// Print outputs if any
	if len(outputs) > 0 {
		fmt.Println("--- Outputs ---")
		for key, value := range outputs {
			// Truncate long values for readability
			displayValue := value
			if len(displayValue) > 100 {
				displayValue = displayValue[:97] + "..."
			}
			fmt.Printf("  %s = %s\n", key, displayValue)
		}
	}

	// Print status
	statusIcon := "✓"
	if status != "success" && status != "warn" {
		statusIcon = "✗"
	}
	fmt.Printf("--- Result: %s %s ---\n", statusIcon, status)
	if err != nil {
		fmt.Printf("  Error: %s\n", err.Error())
	}
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

// executeBlock executes a single block and returns status, exit code, outputs, logs, and error.
func (e *TestExecutor) executeBlock(executable *api.Executable) (string, int, map[string]string, string, error) {
	// Get session context
	execCtx, valid := e.session.ValidateToken(e.getSessionToken())
	if !valid {
		return "error", -1, nil, "", fmt.Errorf("invalid session")
	}

	// Prepare script content
	scriptContent := executable.ScriptContent

	// Check for missing block output dependencies before rendering
	// This provides a clearer error message than the Go template "map has no entry for key" error
	if missing := e.findMissingOutputDependencies(scriptContent); len(missing) > 0 {
		return "error", -1, nil, "", fmt.Errorf("block references outputs that haven't been produced yet: %s. "+
			"Make sure the blocks that produce these outputs run before this block in your test steps",
			strings.Join(missing, ", "))
	}

	// Always render template variables in test mode
	// Scripts may reference _blocks outputs which aren't detected by TemplateVarNames
	vars := e.buildTemplateVars()
	rendered, err := api.RenderBoilerplateContent(scriptContent, vars)
	if err != nil {
		return "error", -1, nil, "", fmt.Errorf("failed to render template: %w", err)
	}
	scriptContent = rendered

	// Create temp files for outputs and file capture
	outputFile, err := os.CreateTemp("", "runbook-output-*.txt")
	if err != nil {
		return "error", -1, nil, "", fmt.Errorf("failed to create output file: %w", err)
	}
	outputFilePath := outputFile.Name()
	outputFile.Close()
	defer os.Remove(outputFilePath)

	filesDir, err := os.MkdirTemp("", "runbook-files-*")
	if err != nil {
		return "error", -1, nil, "", fmt.Errorf("failed to create files directory: %w", err)
	}
	defer os.RemoveAll(filesDir)

	// Prepare script for execution using the same helper as the runbook server
	// This handles interpreter detection, env capture wrapping, and temp file creation
	scriptSetup, err := api.PrepareScriptForExecution(scriptContent, executable.Language)
	if err != nil {
		return "error", -1, nil, "", err
	}
	defer scriptSetup.Cleanup()

	// Create command
	ctx, cancel := context.WithTimeout(context.Background(), e.timeout)
	defer cancel()

	cmdArgs := append(scriptSetup.Args, scriptSetup.ScriptPath)
	cmd := exec.CommandContext(ctx, scriptSetup.Interpreter, cmdArgs...)

	// Set environment
	cmd.Env = execCtx.Env
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_OUTPUT=%s", outputFilePath))
	cmd.Env = append(cmd.Env, fmt.Sprintf("RUNBOOK_FILES=%s", filesDir))

	// Set working directory
	if execCtx.WorkDir != "" {
		cmd.Dir = execCtx.WorkDir
	}

	// Capture output to buffer instead of streaming
	var combinedOutput bytes.Buffer
	cmd.Stdout = &combinedOutput
	cmd.Stderr = &combinedOutput

	// Start and wait for command
	if err := cmd.Start(); err != nil {
		return "error", -1, nil, "", fmt.Errorf("failed to start script: %w", err)
	}

	// Wait for completion
	waitErr := cmd.Wait()
	logs := combinedOutput.String()

	// Determine status
	exitCode := 0
	status := "success"
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			return "timeout", -1, nil, logs, fmt.Errorf("script execution timed out")
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

	// Capture environment changes from bash scripts and update session
	if status == "success" || status == "warn" {
		if err := scriptSetup.CaptureEnvironmentChanges(e.session, execCtx.WorkDir); err != nil {
			slog.Warn("Failed to update session environment", "error", err)
		}
	}

	// Copy captured files to output directory
	if status == "success" || status == "warn" {
		if err := e.captureFiles(filesDir); err != nil {
			slog.Warn("Failed to capture files", "error", err)
		}
	}

	return status, exitCode, outputs, logs, nil
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
	case StatusConfigError:
		return actual == "config_error"
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
	// Use a more permissive regex that finds _blocks.xxx.outputs.yyy anywhere in the content
	// This handles patterns inside function calls like: fromJson ._blocks.list_users.outputs.users
	re := regexp.MustCompile(`_blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)`)
	matches := re.FindAllStringSubmatch(scriptContent, -1)

	seen := make(map[string]bool)
	var missing []string

	for _, match := range matches {
		if len(match) < 3 {
			continue
		}
		blockID := match[1]
		outputName := match[2]

		// Deduplicate
		key := blockID + "." + outputName
		if seen[key] {
			continue
		}
		seen[key] = true

		// Templates use underscores (Go template limitation), but block IDs in MDX use hyphens.
		// We need to check both forms since blockOutputs uses the original block ID (with hyphens).
		hyphenatedBlockID := strings.ReplaceAll(blockID, "_", "-")

		// Check if this block's output exists (try both hyphenated and original forms)
		blockOutputs, blockExists := e.blockOutputs[blockID]
		if !blockExists {
			blockOutputs, blockExists = e.blockOutputs[hyphenatedBlockID]
		}

		// Use the hyphenated form for display since that's what the user sees in MDX
		displayBlockID := hyphenatedBlockID

		if !blockExists {
			missing = append(missing, fmt.Sprintf("{{ ._blocks.%s.outputs.%s }} (block %q hasn't run yet)",
				blockID, outputName, displayBlockID))
		} else if _, outputExists := blockOutputs[outputName]; !outputExists {
			missing = append(missing, fmt.Sprintf("{{ ._blocks.%s.outputs.%s }} (block %q ran but didn't produce output %q)",
				blockID, outputName, displayBlockID, outputName))
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

// getBlockType determines the type of a block from its ID.
// Returns "Check", "Command", "Template", or "TemplateInline".
func (e *TestExecutor) getBlockType(blockID string) string {
	// Check if it's a TemplateInline block
	if _, ok := e.templateInlines[blockID]; ok {
		return "TemplateInline"
	}

	// Check if it's a Template block
	if _, ok := e.templates[blockID]; ok {
		return "Template"
	}

	// Check the registry for Check/Command blocks
	for _, exec := range e.registry.GetAllExecutables() {
		if exec.ComponentID == blockID {
			// ComponentType is stored as "check" or "command"
			switch exec.ComponentType {
			case "check":
				return "Check"
			case "command":
				return "Command"
			default:
				// Capitalize first letter for unknown types
				if len(exec.ComponentType) > 0 {
					return strings.ToUpper(exec.ComponentType[:1]) + exec.ComponentType[1:]
				}
				return "Block"
			}
		}
	}

	return "Block" // Fallback if type can't be determined
}

// formatBlockError creates a detailed error message for a failed block.
func (e *TestExecutor) formatBlockError(blockID string, stepResult StepResult) string {
	blockType := e.getBlockType(blockID)

	// If there's a specific error message, use it
	if stepResult.Error != "" {
		return fmt.Sprintf("%s block %q failed: %s", blockType, blockID, stepResult.Error)
	}

	// No specific error - build a detailed message from available info
	var details []string

	// Add status info
	if stepResult.ActualStatus != "" {
		details = append(details, fmt.Sprintf("status=%s", stepResult.ActualStatus))
	}

	// Add exit code if relevant
	if stepResult.ExitCode != 0 {
		details = append(details, fmt.Sprintf("exit_code=%d", stepResult.ExitCode))
	}

	// Add truncated log output if available
	if stepResult.Logs != "" {
		// Get last few lines of output (most relevant)
		lines := strings.Split(strings.TrimSpace(stepResult.Logs), "\n")
		maxLines := 5
		if len(lines) > maxLines {
			lines = lines[len(lines)-maxLines:]
		}
		logSnippet := strings.Join(lines, "\n")
		if logSnippet != "" {
			details = append(details, fmt.Sprintf("output:\n%s", logSnippet))
		}
	}

	if len(details) > 0 {
		return fmt.Sprintf("%s block %q failed:\n  %s", blockType, blockID, strings.Join(details, "\n  "))
	}

	return fmt.Sprintf("%s block %q failed", blockType, blockID)
}
