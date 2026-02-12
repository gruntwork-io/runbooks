package testing

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"runbooks/api"
)

// =============================================================================
// Block Types
// =============================================================================
//
// Runbooks uses "blocks" to describe the building blocks of a runbook.
// Each block type has specific behavior during test execution.

// BlockType identifies a type of MDX block.
type BlockType string

// Known block types supported by runbooks test.
const (
	BlockTypeCheck          BlockType = "Check"
	BlockTypeCommand        BlockType = "Command"
	BlockTypeInputs         BlockType = "Inputs"
	BlockTypeTemplate       BlockType = "Template"
	BlockTypeTemplateInline BlockType = "TemplateInline"
	BlockTypeAwsAuth        BlockType = "AwsAuth"
	BlockTypeGitHubAuth     BlockType = "GitHubAuth"
	BlockTypeGitClone           BlockType = "GitClone"
	BlockTypeGitHubPullRequest BlockType = "GitHubPullRequest"
	BlockTypeAdmonition        BlockType = "Admonition"
)

// =============================================================================
// Auth Blocks
// =============================================================================
//
// Auth blocks are a subset of block types that provide credentials to dependent blocks.
// When an auth block is skipped (no credentials available), dependent blocks are also skipped.

// authBlockTypes lists block types that are authentication blocks.
// Add new auth types here - the rest of the system uses this as the source of truth.
var authBlockTypes = []BlockType{
	BlockTypeAwsAuth,
	BlockTypeGitHubAuth,
}

// isAuthBlock returns true if the block type is an authentication block.
func isAuthBlock(blockType string) bool {
	for _, ab := range authBlockTypes {
		if string(ab) == blockType {
			return true
		}
	}
	return false
}

// authBlockRefPropNameOverrides maps block types to their prop name prefixes
// for cases where the standard lowercaseFirst convention doesn't apply.
// For example, "GitHubAuth" uses "githubAuthId" (not "gitHubAuthId").
var authBlockRefPropNameOverrides = map[BlockType]string{
	BlockTypeGitHubAuth: "githubAuthId",
}

// authBlockRefPropName returns the prop name used to reference an auth block.
// Convention: lowercaseFirst(blockType) + "Id" (e.g., "AwsAuth" -> "awsAuthId")
// Some block types have special-cased names (e.g., "GitHubAuth" -> "githubAuthId").
func authBlockRefPropName(blockType BlockType) string {
	if override, ok := authBlockRefPropNameOverrides[blockType]; ok {
		return override
	}
	return lowercaseFirst(string(blockType)) + "Id"
}

// authBlockDependentTypes lists block types that can depend on auth blocks.
// These are the block types that can have awsAuthId/githubAuthId props.
var authBlockDependentTypes = []BlockType{
	BlockTypeCheck,
	BlockTypeCommand,
	BlockTypeGitClone,
	BlockTypeGitHubPullRequest,
}

// =============================================================================
// Block State
// =============================================================================

// BlockState represents the execution state of a block.
// Currently tracked for auth blocks to propagate skip state to dependent blocks.
type BlockState string

const (
	BlockStateSuccess BlockState = "success" // Block executed successfully
	BlockStateSkipped BlockState = "skipped" // Block was skipped (e.g., no credentials)
)

// =============================================================================
// Dependencies
// =============================================================================
//
// Blocks can depend on other blocks in two ways:
// 1. Auth dependencies: Command/Check blocks reference auth blocks via props like
//    githubAuthId="auth-block-id". When the auth block is skipped, dependent blocks
//    are also skipped.
// 2. Output dependencies: Template blocks reference outputs from Command/Check blocks
//    via {{ ._blocks.blockId.outputs.outputName }}. These are checked at render time.

// AuthDependency represents a block's dependency on an auth block for credentials.
type AuthDependency struct {
	BlockID       string    // The block that has the dependency (e.g., "run-script")
	AuthBlockID   string    // The auth block it depends on (e.g., "github-auth")
	AuthBlockType BlockType // The type of auth block (for error messages)
}

// TestExecutor runs runbook tests in headless mode.
type TestExecutor struct {
	runbookPath string
	workingDir  string // Working directory for script execution and template output base
	outputPath  string // Output path relative to workingDir (default: "generated")
	registry    *api.ExecutableRegistry
	session     *api.SessionManager
	timeout     time.Duration
	verbose     bool
	validator   *InputValidator

	// Track block outputs during test execution
	blockOutputs map[string]map[string]string // blockID -> outputName -> value

	// Test inputs from the current test case
	testInputs map[string]interface{} // inputsID.varName -> value

	// Test environment variables from the current test case
	testEnv map[string]string // envVarName -> value

	// Parsed TemplateInline blocks from the runbook
	templateInlines map[string]*TemplateInlineBlock // blockID -> block info

	// Parsed Template blocks from the runbook
	templates map[string]*TemplateBlock // blockID -> block info

	// Track block states for dependency checking (currently auth blocks only)
	blockStates map[string]BlockState // blockID -> state

	// Auth dependencies: which blocks depend on which auth blocks
	authDeps map[string]AuthDependency // blockID -> auth dependency

	// Auth block credentials: stores credentials per-auth-block for awsAuthId/githubAuthId support
	// When a Check/Command specifies awsAuthId="my-auth", we look up credentials from this map
	// instead of just using the session environment
	authBlockCredentials map[string]map[string]string // authBlockID -> envVarName -> value

	// Active worktree path: set by the last successful GitClone block.
	// Used to inject REPO_FILES environment variable into Command/Check scripts.
	activeWorkTreePath string
}

// resolveOutputPath returns the absolute path to the output directory.
func (e *TestExecutor) resolveOutputPath() string {
	return filepath.Join(e.workingDir, e.outputPath)
}

// getenv returns a lookup function that consults e.testEnv first, then falls
// back to os.Getenv. An empty-string value in testEnv is treated as "explicitly
// cleared" (returns ""), which lets test configs override real env vars to empty.
func (e *TestExecutor) getenv(key string) string {
	if e.testEnv != nil {
		if val, ok := e.testEnv[key]; ok {
			return val
		}
	}
	return os.Getenv(key)
}

// TemplateInlineBlock holds information about a TemplateInline block parsed from the runbook
type TemplateInlineBlock struct {
	ID           string
	Content      string // The template content (between the tags)
	OutputPath   string // The outputPath prop
	InputsID     string // The inputsId prop (may be empty)
	Target       string // The target prop: "generated" (default) or "worktree"
	GenerateFile bool   // Whether to write the file to disk
}

// TemplateBlock holds information about a Template block parsed from the runbook
type TemplateBlock struct {
	ID           string
	TemplatePath string // The path prop (relative to runbook directory)
	InputsID     string // The inputsId prop (may be empty)
	Target       string // The target prop: "generated" (default) or "worktree"
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

// WithWorkingDir sets the initial working directory for script execution.
// This overrides the default set during executor creation.
func WithWorkingDir(dir string) ExecutorOption {
	return func(e *TestExecutor) {
		if dir != "" {
			// Update the executor's working directory
			e.workingDir = dir
			// Update the session's working directory
			if session, ok := e.session.GetSession(); ok {
				session.InitialWorkDir = dir
				session.WorkingDir = dir
			}
		}
	}
}

// NewTestExecutor creates a new test executor for a runbook.
// workingDir is the base directory for script execution and template output.
// outputPath is the path relative to workingDir where generated files will be written (default: "generated").
func NewTestExecutor(runbookPath, workingDir, outputPath string, opts ...ExecutorOption) (*TestExecutor, error) {
	// Create executable registry to parse the runbook
	registry, err := api.NewExecutableRegistry(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to parse runbook: %w", err)
	}

	// Create session manager
	session := api.NewSessionManager()

	// Initialize session with the provided working directory
	if _, err := session.CreateSession(workingDir); err != nil {
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

	// Parse auth dependencies (blocks that reference auth blocks)
	authDeps, err := parseAuthDependencies(runbookPath)
	if err != nil {
		return nil, fmt.Errorf("failed to parse auth dependencies: %w", err)
	}

	// Default outputPath to "generated"
	if outputPath == "" {
		outputPath = "generated"
	}

	e := &TestExecutor{
		runbookPath:          runbookPath,
		workingDir:           workingDir,
		outputPath:           outputPath,
		registry:             registry,
		session:              session,
		timeout:              5 * time.Minute,
		verbose:              false,
		validator:            validator,
		blockOutputs:         make(map[string]map[string]string),
		templateInlines:      templateInlines,
		templates:            templates,
		blockStates:          make(map[string]BlockState),
		authDeps:             authDeps,
		authBlockCredentials: make(map[string]map[string]string),
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
		id := GenerateTemplateInlineID(outputPath)
		if id == "" {
			templateCount++
			id = fmt.Sprintf("template-inline-%d", templateCount)
		}

		// Extract the actual template content from code fence if present
		templateContent = extractTemplateContent(templateContent)

		target := extractMDXPropValue(props, "target")
		generateFileStr := extractMDXPropValue(props, "generateFile")
		generateFile := generateFileStr == "true" || generateFileStr == "{true}"

		blocks[id] = &TemplateInlineBlock{
			ID:           id,
			Content:      templateContent,
			OutputPath:   outputPath,
			InputsID:     inputsID,
			Target:       target,
			GenerateFile: generateFile,
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

		target := extractMDXPropValue(props, "target")

		blocks[id] = &TemplateBlock{
			ID:           id,
			TemplatePath: templatePath,
			InputsID:     inputsID,
			Target:       target,
		}
	}

	return blocks, nil
}

// parseAuthDependencies scans a runbook for blocks that depend on auth blocks.
//
// It looks for Check/Command blocks with props like:
//
//	<Command id="deploy" awsAuthId="aws-creds" ... />
//	<Check id="verify" githubAuthId="gh-auth" ... />
//
// Returns a map of blockID -> AuthDependency for use during test execution.
// When an auth block is skipped, its dependent blocks are also skipped.
func parseAuthDependencies(runbookPath string) (map[string]AuthDependency, error) {
	content, err := os.ReadFile(runbookPath)
	if err != nil {
		return nil, err
	}

	deps := make(map[string]AuthDependency)
	contentStr := string(content)

	// Find fenced code block ranges to skip (documentation examples)
	codeBlockRanges := api.FindFencedCodeBlockRanges(contentStr)

	// Scan block types that can have auth dependencies (Check, Command)
	for _, blockType := range authBlockDependentTypes {
		re := api.GetComponentRegex(string(blockType))
		matches := re.FindAllStringSubmatchIndex(contentStr, -1)

		for _, match := range matches {
			// match[0], match[1] = full match start/end
			// match[2], match[3] = first capture group (props) start/end
			if len(match) < 4 {
				continue
			}

			// Skip components inside fenced code blocks (documentation examples)
			if api.IsInsideFencedCodeBlock(match[0], codeBlockRanges) {
				continue
			}

			props := contentStr[match[2]:match[3]]

			blockID := extractMDXPropValue(props, "id")
			if blockID == "" {
				continue
			}

			// Check if this block references any auth block via props like:
			//   awsAuthId="my-aws-auth"
			//   githubAuthId="my-github-auth"
			for _, authType := range authBlockTypes {
				propName := authBlockRefPropName(authType) // e.g., "awsAuthId"
				if authID := extractMDXPropValue(props, propName); authID != "" {
					deps[blockID] = AuthDependency{
						BlockID:       blockID,
						AuthBlockID:   authID,
						AuthBlockType: authType,
					}
					break // A block can only depend on one auth block
				}
			}
		}
	}

	return deps, nil
}

// extractMDXPropValue extracts a prop value from an MDX props string
func extractMDXPropValue(props, propName string) string {
	patterns := []string{
		fmt.Sprintf(`%s="([^"]*)"`, propName),
		fmt.Sprintf(`%s='([^']*)'`, propName),
		fmt.Sprintf(`%s=\{`+"`([^`]*)`"+`\}`, propName),
		fmt.Sprintf(`%s=\{"([^"]*)"\}`, propName),
		fmt.Sprintf(`%s=\{'([^']*)'\}`, propName),
		// Match bare JSX expressions like generateFile={true} or count={42}
		fmt.Sprintf(`%s=\{([^}]+)\}`, propName),
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

	// 0. Check for unknown component errors (before doing anything else)
	for _, err := range e.validator.GetConfigErrors() {
		if err.ComponentID == "(unknown)" {
			result.Status = TestFailed
			result.Error = fmt.Sprintf("<%s>: %s", err.ComponentType, err.Message)
			result.Duration = time.Since(start)
			return result
		}
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

	// Print resolved inputs in verbose mode
	if e.verbose && len(resolvedInputs) > 0 {
		fmt.Println("\n--- Test Inputs ---")
		// Sort keys for consistent output
		keys := make([]string, 0, len(resolvedInputs))
		for k := range resolvedInputs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := resolvedInputs[k]
			// Truncate long values for readability
			displayValue := fmt.Sprintf("%v", v)
			if len(displayValue) > 80 {
				displayValue = displayValue[:77] + "..."
			}
			fmt.Printf("  %s = %s\n", k, displayValue)
		}
	}

	e.testInputs = resolvedInputs

	// Set test environment variables
	e.testEnv = tc.Env

	// Reset block outputs for this test
	e.blockOutputs = make(map[string]map[string]string)

	// 3. Get all blocks in document order
	allBlocks := e.validator.GetComponents()

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
	for _, block := range allBlocks {
		stepResult := e.processBlock(block, stepsToExecute, expectsConfigError, registryWarnings, hasExplicitSteps)
		result.StepResults = append(result.StepResults, stepResult)

		// Check if we should stop execution
		if !stepResult.Passed {
			// Determine if this block was requested (in steps list or no explicit steps)
			_, isRequested := stepsToExecute[block.ID]
			if !hasExplicitSteps || isRequested {
				// Unexpected error in a requested block - stop execution
				result.Status = TestFailed
				result.Error = e.formatBlockErrorFromResult(block, stepResult)
				break
			}
			// Error in non-requested block - continue but mark as failed
			// (This shouldn't happen often since non-requested blocks aren't executed)
		}

		// Run per-step assertions if this was an executed step
		if step, ok := stepsToExecute[block.ID]; ok && stepResult.Passed {
			for _, assertion := range step.Assertions {
				ar := e.runAssertion(assertion)
				stepResult.AssertionResults = append(stepResult.AssertionResults, ar)
				if !ar.Passed {
					result.Status = TestFailed
					result.Error = fmt.Sprintf("%s block %q assertion failed: %s", block.Type, block.ID, ar.Message)
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
	block api.ParsedComponent,
	stepsToExecute map[string]TestStep,
	expectsConfigError map[string]bool,
	registryWarnings []string,
	hasExplicitSteps bool,
) StepResult {
	start := time.Now()

	// Determine if this block should be executed
	step, shouldExecute := stepsToExecute[block.ID]
	if !hasExplicitSteps {
		// No explicit steps - execute all executable blocks
		shouldExecute = block.Type != string(BlockTypeInputs) // Inputs blocks are validation-only
		step = TestStep{Block: block.ID, Expect: StatusSuccess}
	}

	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(block.Type), block.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// 1. Check for configuration errors
	configError := e.getConfigErrorForBlock(block, registryWarnings)

	// 2. Handle config errors
	if configError != "" {
		result.ActualStatus = "config_error"
		result.Error = configError

		// Determine if this block was requested
		_, isRequested := stepsToExecute[block.ID]
		isRequested = isRequested || !hasExplicitSteps // All blocks are "requested" when no explicit steps

		if expectsConfigError[block.ID] {
			// Check error_contains if specified
			if step.ErrorContains != "" && !strings.Contains(strings.ToLower(configError), strings.ToLower(step.ErrorContains)) {
				// Error doesn't contain expected text
				result.Passed = false
				if e.verbose {
					fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
					fmt.Printf("--- Result: ✗ config_error (wrong message) ---\n")
					fmt.Printf("  Expected error containing: %s\n", step.ErrorContains)
					fmt.Printf("  Actual error: %s\n", configError)
					result.ErrorDisplayed = true
				}
			} else {
				// Expected config error - pass
				result.Passed = true
				if e.verbose {
					fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
					fmt.Printf("--- Result: ✓ config_error (expected) ---\n")
					fmt.Printf("  Error: %s\n", configError)
					result.ErrorDisplayed = true
				}
			}
		} else if !isRequested {
			// Config error in non-requested block - show as warning but don't fail
			result.Passed = true // Don't fail the test for non-requested blocks
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
				fmt.Printf("--- Config: ⚠ error (not in steps) ---\n")
				fmt.Printf("  Error: %s\n", configError)
				result.ErrorDisplayed = true
			}
		} else {
			// Unexpected config error in requested block - fail
			result.Passed = false
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
				fmt.Printf("--- Result: ✗ config_error ---\n")
				fmt.Printf("  Error: %s\n", configError)
				result.ErrorDisplayed = true
			}
		}
		result.Duration = time.Since(start)
		return result
	}

	// 3. For Inputs blocks: validation-only, show "Config: valid"
	if block.Type == string(BlockTypeInputs) {
		result.ActualStatus = "valid"
		result.Passed = true
		if e.verbose {
			fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
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

	// 5. Check auth dependencies before executing
	if authDep, hasAuthDep := e.authDeps[block.ID]; hasAuthDep {
		authState, authExecuted := e.blockStates[authDep.AuthBlockID]
		if !authExecuted {
			// Auth block hasn't been executed yet
			result.Passed = false
			result.ActualStatus = "blocked"
			result.Error = fmt.Sprintf("block depends on %q which hasn't been executed yet", authDep.AuthBlockID)
			result.Duration = time.Since(start)
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
				fmt.Printf("--- Result: ✗ blocked ---\n")
				fmt.Printf("  Error: %s\n", result.Error)
			}
			return result
		}

		if authState == BlockStateSkipped {
			// Auth block was skipped - this block can't run unless explicitly skipped
			if step.Expect == StatusSkip {
				result.Passed = true
				result.ActualStatus = "skipped"
				result.Duration = time.Since(start)
				if e.verbose {
					fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
					fmt.Println("  (skipped - auth dependency not available)")
				}
				return result
			}

			// User didn't explicitly skip, so this is an error
			result.Passed = false
			result.ActualStatus = "blocked"
			result.Error = fmt.Sprintf("block depends on %q which was skipped (no credentials available). "+
				"Either provide credentials or set 'expect: skip' for this block", authDep.AuthBlockID)
			result.Duration = time.Since(start)
			if e.verbose {
				fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
				fmt.Printf("--- Result: ✗ blocked ---\n")
				fmt.Printf("  Error: %s\n", result.Error)
			}
			return result
		}
	}

	// 6. Execute the block
	return e.dispatchBlock(block, step, start)
}

// getConfigErrorForBlock returns any configuration error for the block.
func (e *TestExecutor) getConfigErrorForBlock(block api.ParsedComponent, registryWarnings []string) string {
	switch block.Type {
	case string(BlockTypeCheck), string(BlockTypeCommand):
		// For Check/Command, check both registry warnings and validator config errors.
		// Registry warnings cover file-not-found errors; validator covers structural errors like missing ID.
		if warning := e.getRegistryWarningForBlock(registryWarnings, block.ID); warning != "" {
			return warning
		}
		return e.validator.GetConfigError(block.Type, block.ID)
	case string(BlockTypeInputs), string(BlockTypeTemplate), string(BlockTypeTemplateInline), string(BlockTypeAdmonition), string(BlockTypeGitClone), string(BlockTypeGitHubPullRequest):
		return e.validator.GetConfigError(block.Type, block.ID)
	default:
		// Check if it's an auth block
		if isAuthBlock(block.Type) {
			return e.validator.GetConfigError(block.Type, block.ID)
		}
		// Unknown block type - this is a configuration error
		return fmt.Sprintf("unknown block type %q is not supported by runbooks test", block.Type)
	}
}

// dispatchBlock dispatches a block to the appropriate execution handler and returns the result.
func (e *TestExecutor) dispatchBlock(block api.ParsedComponent, step TestStep, start time.Time) StepResult {
	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(block.Type), block.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Print block header if verbose
	if e.verbose {
		fmt.Printf("\n=== %s: %s ===\n", block.Type, block.ID)
	}

	// Handle skip expectation
	if step.Expect == StatusSkip {
		result.Passed = true
		result.ActualStatus = "skipped"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Println("  (skipped)")
		}
		// For auth blocks, record the skipped state so dependent blocks know
		if isAuthBlock(block.Type) {
			e.blockStates[block.ID] = BlockStateSkipped
		}
		return result
	}

	// Handle config_error expectation - but config errors were already checked above
	// If we reach here with config_error expectation but no config error, it's an error
	if step.Expect == StatusConfigError {
		result.Passed = false
		result.ActualStatus = "no_config_error"
		result.Error = "expected config_error but block configuration is valid"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ no_config_error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// Execute based on block type
	switch block.Type {
	case string(BlockTypeTemplateInline):
		if templateInline, ok := e.templateInlines[block.ID]; ok {
			return e.executeTemplateInline(step, templateInline, start)
		}
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("TemplateInline block %q not found", block.ID)
		result.Duration = time.Since(start)
		return result

	case string(BlockTypeTemplate):
		if template, ok := e.templates[block.ID]; ok {
			return e.executeTemplate(step, template, start)
		}
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("Template block %q not found", block.ID)
		result.Duration = time.Since(start)
		return result

	case string(BlockTypeCheck), string(BlockTypeCommand):
		// Find the executable for this block
		var executable *api.Executable
		for _, exec := range e.registry.GetAllExecutables() {
			if exec.ComponentID == block.ID {
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
			result.Error = fmt.Sprintf("block %q not found in runbook", block.ID)
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
			e.printBlockOutput(block.ID, logs, outputs, status, err)
		}

		// Store outputs for later assertions
		if len(outputs) > 0 {
			e.blockOutputs[block.ID] = outputs
		}

		if err != nil {
			result.Error = err.Error()
		}

		// Check if result matches expected status
		result.Passed = e.matchesExpectedStatus(step.Expect, status, exitCode)
		result.Duration = time.Since(start)
		return result

	case string(BlockTypeGitHubAuth):
		return e.executeGitHubAuth(block, step, start)

	case string(BlockTypeAwsAuth):
		return e.executeAwsAuth(block, step, start)

	case string(BlockTypeGitClone):
		return e.executeGitClone(block, step, start)

	case string(BlockTypeGitHubPullRequest):
		// GitHubPullRequest blocks are always skipped in test mode because they
		// require interactive GitHub token and create real PRs.
		result.Passed = step.Expect == StatusSkip
		result.ActualStatus = "skipped"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Println("  (GitHubPullRequest blocks are skipped in test mode)")
		}
		return result

	case string(BlockTypeAdmonition):
		// Decorative block - just pass validation, no execution needed
		result.Passed = true
		result.ActualStatus = "success"
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Println("  (decorative block - no execution)")
		}
		return result

	default:
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("unsupported block type %q for execution", block.Type)
		result.Duration = time.Since(start)
		return result
	}
}

// formatBlockErrorFromResult formats an error message for a failed block.
func (e *TestExecutor) formatBlockErrorFromResult(block api.ParsedComponent, stepResult StepResult) string {
	if stepResult.ErrorDisplayed {
		// Error was already shown in verbose mode
		return fmt.Sprintf("%s block '%s' failed (see details above)", block.Type, block.ID)
	}

	var msg string
	if stepResult.Error != "" {
		msg = fmt.Sprintf("%s block '%s': %s", block.Type, block.ID, stepResult.Error)
	} else {
		msg = fmt.Sprintf("%s block '%s' failed with status: %s", block.Type, block.ID, stepResult.ActualStatus)
	}

	// Include script output (stdout/stderr) if available - helpful for debugging
	if stepResult.Logs != "" {
		// Truncate to last N lines if output is long
		lines := strings.Split(strings.TrimSpace(stepResult.Logs), "\n")
		maxLines := 20
		if len(lines) > maxLines {
			lines = append([]string{fmt.Sprintf("... (%d lines truncated) ...", len(lines)-maxLines)}, lines[len(lines)-maxLines:]...)
		}
		msg += fmt.Sprintf("\n\n--- Script Output ---\n%s", strings.Join(lines, "\n"))
	}

	return msg
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

	// If generateFile is true, write the rendered content to disk
	if block.GenerateFile && block.OutputPath != "" {
		var outputDir string
		if block.Target == "worktree" {
			if e.activeWorkTreePath == "" {
				result.Passed = false
				result.ActualStatus = "error"
				result.Error = "target is \"worktree\" but no git worktree has been cloned. Use a <GitClone> block first"
				result.Duration = time.Since(start)
				if e.verbose {
					fmt.Printf("--- Result: ✗ error ---\n")
					fmt.Printf("  Error: %s\n", result.Error)
				}
				return result
			}
			outputDir = e.activeWorkTreePath
		} else {
			outputDir = e.resolveOutputPath()
		}

		outputFile := filepath.Join(outputDir, block.OutputPath)
		if err := os.MkdirAll(filepath.Dir(outputFile), 0755); err != nil {
			result.Passed = false
			result.ActualStatus = "error"
			result.Error = fmt.Sprintf("failed to create output directory: %v", err)
			result.Duration = time.Since(start)
			return result
		}
		if err := os.WriteFile(outputFile, []byte(rendered), 0644); err != nil {
			result.Passed = false
			result.ActualStatus = "error"
			result.Error = fmt.Sprintf("failed to write file: %v", err)
			result.Duration = time.Since(start)
			return result
		}
		if e.verbose {
			fmt.Printf("--- Wrote file: %s ---\n", outputFile)
		}
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

	// Determine output directory based on target
	var outputDir string
	if block.Target == "worktree" {
		if e.activeWorkTreePath == "" {
			result.Passed = false
			result.ActualStatus = "error"
			result.Error = "target is \"worktree\" but no git worktree has been cloned. Use a <GitClone> block first"
			result.Duration = time.Since(start)
			if e.verbose {
				fmt.Printf("--- Result: ✗ error ---\n")
				fmt.Printf("  Error: %s\n", result.Error)
			}
			return result
		}
		outputDir = e.activeWorkTreePath
	} else {
		outputDir = e.resolveOutputPath()
	}

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
		if block.Target == "worktree" {
			fmt.Printf("  Target: worktree\n")
		}
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

// DefaultGitHubAuthEnvVar is the default environment variable for GitHub tokens in tests.
// Using RUNBOOKS_GITHUB_TOKEN instead of GITHUB_TOKEN prevents accidentally using
// credentials from an authenticated session when running tests.
const DefaultGitHubAuthEnvVar = "RUNBOOKS_GITHUB_TOKEN"

// executeGitHubAuth handles GitHubAuth block execution in test mode.
// It looks for GitHub tokens in environment variables and injects them into the session.
// If env_prefix is set on the test step, it checks {prefix}GITHUB_TOKEN and {prefix}GH_TOKEN.
// Otherwise it falls back to RUNBOOKS_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN.
// If no token is found, the block is marked as skipped.
func (e *TestExecutor) executeGitHubAuth(block api.ParsedComponent, step TestStep, start time.Time) StepResult {
	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(string(BlockTypeGitHubAuth)), block.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Get prefix from test step config (env_prefix field in runbook_test.yml)
	prefix := step.EnvPrefix

	var token string
	var tokenSource string

	// Use e.getenv so that test environment overrides from runbook_test.yml
	// are respected (e.g., clearing GITHUB_TOKEN to force a skip).
	getenv := e.getenv

	if prefix != "" {
		// If env_prefix specified on test step, check prefixed vars
		token = getenv(prefix + "GITHUB_TOKEN")
		if token != "" {
			tokenSource = prefix + "GITHUB_TOKEN"
		} else {
			token = getenv(prefix + "GH_TOKEN")
			if token != "" {
				tokenSource = prefix + "GH_TOKEN"
			}
		}
	} else {
		// Default behavior: check RUNBOOKS_GITHUB_TOKEN first, then standard vars
		token = getenv(DefaultGitHubAuthEnvVar)
		if token != "" {
			tokenSource = DefaultGitHubAuthEnvVar
		} else {
			token = getenv("GITHUB_TOKEN")
			if token != "" {
				tokenSource = "GITHUB_TOKEN"
			} else {
				token = getenv("GH_TOKEN")
				if token != "" {
					tokenSource = "GH_TOKEN"
				}
			}
		}
	}

	if token == "" {
		// No token found - skip this block
		if e.verbose {
			fmt.Printf("--- No credentials found ---\n")
			if prefix != "" {
				fmt.Printf("  Checked: %sGITHUB_TOKEN, %sGH_TOKEN\n", prefix, prefix)
			} else {
				fmt.Printf("  Checked: %s, GITHUB_TOKEN, GH_TOKEN\n", DefaultGitHubAuthEnvVar)
			}
			fmt.Printf("--- Result: skipped (no credentials) ---\n")
		}

		e.blockStates[block.ID] = BlockStateSkipped
		result.ActualStatus = "skipped"
		result.Passed = e.matchesExpectedStatus(step.Expect, "skipped", 0)
		result.Duration = time.Since(start)
		return result
	}

	// Token found - inject into session
	envVars := map[string]string{
		"GITHUB_TOKEN": token,
	}
	if err := e.session.AppendToEnv(envVars); err != nil {
		result.Passed = false
		result.ActualStatus = "error"
		result.Error = fmt.Sprintf("failed to inject GitHub credentials: %v", err)
		result.Duration = time.Since(start)
		if e.verbose {
			fmt.Printf("--- Result: ✗ error ---\n")
			fmt.Printf("  Error: %s\n", result.Error)
		}
		return result
	}

	// Store per-block credentials for githubAuthId lookups
	e.authBlockCredentials[block.ID] = envVars

	// Success
	e.blockStates[block.ID] = BlockStateSuccess
	result.ActualStatus = "success"
	result.Passed = e.matchesExpectedStatus(step.Expect, "success", 0)
	result.Duration = time.Since(start)

	if e.verbose {
		fmt.Printf("--- Credentials found: %s ---\n", tokenSource)
		fmt.Printf("  Injected GITHUB_TOKEN into session\n")
		fmt.Printf("--- Result: ✓ success ---\n")
	}

	return result
}

// executeGitClone handles GitClone block execution in test mode.
// It performs a git clone using the block's prefilledUrl, prefilledRef, prefilledRepoPath, and prefilledLocalPath props.
// If a gitHubAuthId is specified and the referenced auth block has credentials, the token is injected.
func (e *TestExecutor) executeGitClone(block api.ParsedComponent, step TestStep, start time.Time) StepResult {
	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(string(BlockTypeGitClone)), block.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Extract props
	cloneURL := api.ExtractProp(block.Props, "prefilledUrl")
	ref := api.ExtractProp(block.Props, "prefilledRef")
	repoPath := api.ExtractProp(block.Props, "prefilledRepoPath")
	localPath := api.ExtractProp(block.Props, "prefilledLocalPath")

	if cloneURL == "" {
		// No URL specified - skip in test mode (user would fill this in interactively)
		if e.verbose {
			fmt.Printf("--- No prefilledUrl specified ---\n")
			fmt.Printf("--- Result: skipped (no URL to clone) ---\n")
		}
		e.blockStates[block.ID] = BlockStateSkipped
		result.ActualStatus = "skipped"
		result.Passed = e.matchesExpectedStatus(step.Expect, "skipped", 0)
		result.Duration = time.Since(start)
		return result
	}

	absolutePath, _ := api.ResolveClonePaths(localPath, cloneURL, e.workingDir)

	// Inject GitHub token if available
	effectiveURL := cloneURL
	if api.IsGitHubURL(cloneURL) {
		// Check gitHubAuthId first
		gitHubAuthId := api.ExtractProp(block.Props, "gitHubAuthId")
		if gitHubAuthId != "" {
			if creds, ok := e.authBlockCredentials[gitHubAuthId]; ok {
				if token, ok := creds["GITHUB_TOKEN"]; ok && token != "" {
					effectiveURL = api.InjectGitHubToken(cloneURL, token)
				}
			}
		} else {
			// Fallback to session env
			if token := e.getSessionEnvVar("GITHUB_TOKEN"); token != "" {
				effectiveURL = api.InjectGitHubToken(cloneURL, token)
			} else if token := e.getSessionEnvVar("GH_TOKEN"); token != "" {
				effectiveURL = api.InjectGitHubToken(cloneURL, token)
			}
		}
	}

	if e.verbose {
		fmt.Printf("--- Cloning %s ---\n", cloneURL)
		if ref != "" {
			fmt.Printf("  Ref: %s\n", ref)
		}
		if repoPath != "" {
			fmt.Printf("  Sparse checkout path: %s\n", repoPath)
		}
		fmt.Printf("  Destination: %s\n", absolutePath)
	}

	// Perform the clone using the same core functions as the runtime server
	cloneCtx, cloneCancel := context.WithTimeout(context.Background(), e.timeout)
	defer cloneCancel()

	var cloneErr error
	if repoPath != "" {
		_, cloneErr = api.GitSparseCloneSimple(cloneCtx, effectiveURL, absolutePath, repoPath, ref)
	} else {
		_, cloneErr = api.GitCloneSimple(cloneCtx, effectiveURL, absolutePath, ref)
	}

	if cloneErr != nil {
		sanitizedErr := api.SanitizeGitError(cloneErr.Error())
		if e.verbose {
			fmt.Printf("--- Result: ✗ failed ---\n")
			fmt.Printf("  Error: %s\n", sanitizedErr)
		}
		result.Passed = false
		result.ActualStatus = "fail"
		result.Error = sanitizedErr
		result.Duration = time.Since(start)
		return result
	}

	// Count files
	fileCount := api.CountFiles(absolutePath)

	// Store outputs
	result.Outputs["CLONE_PATH"] = absolutePath
	result.Outputs["FILE_COUNT"] = fmt.Sprintf("%d", fileCount)
	if ref != "" {
		result.Outputs["REF"] = ref
	}

	// Store in block outputs for downstream access
	e.blockOutputs[block.ID] = result.Outputs

	// Track this as the active worktree for REPO_FILES injection
	e.activeWorkTreePath = absolutePath

	e.blockStates[block.ID] = BlockStateSuccess
	result.ActualStatus = "success"
	result.Passed = e.matchesExpectedStatus(step.Expect, "success", 0)
	result.Duration = time.Since(start)

	if e.verbose {
		fmt.Printf("--- Clone complete: %d files ---\n", fileCount)
		fmt.Printf("--- Result: ✓ success ---\n")
	}

	return result
}



// getSessionEnvVar reads an env var from the session.
func (e *TestExecutor) getSessionEnvVar(key string) string {
	token := e.getSessionToken()
	execCtx, valid := e.session.ValidateToken(token)
	if !valid {
		return ""
	}
	// Parse KEY=VALUE pairs from session env
	for _, envVar := range execCtx.Env {
		if idx := strings.Index(envVar, "="); idx >= 0 {
			if envVar[:idx] == key {
				return envVar[idx+1:]
			}
		}
	}
	return ""
}

// AwsCredentialSource describes how AWS credentials were obtained.
type AwsCredentialSource string

const (
	AwsCredSourceEnvVars        AwsCredentialSource = "environment_variables"
	AwsCredSourceProfile        AwsCredentialSource = "aws_profile"
	AwsCredSourceOIDC           AwsCredentialSource = "oidc_web_identity"
	AwsCredSourceContainerCreds AwsCredentialSource = "container_credentials"
)

// AwsCredentialInfo holds detailed information about detected AWS credentials.
type AwsCredentialInfo struct {
	Source          AwsCredentialSource
	EnvVars         []string // Which env vars contained the credentials (for env var source)
	ProfileName     string   // Profile name if using AWS_PROFILE
	RoleArn         string   // Role ARN if using OIDC
	TokenFile       string   // Token file path if using OIDC
	HasSessionToken bool     // Whether credentials include a session token
	Region          string   // Region if set
}

// detectAwsCredentials checks all possible sources of AWS credentials and returns
// detailed information about what was found. The getenv function is used to look up
// environment variables, allowing test overrides to be respected.
func detectAwsCredentials(prefix string, getenv func(string) string) (creds api.AwsEnvCredentials, info AwsCredentialInfo, found bool) {
	// 1. Check for explicit static credentials via environment variables
	envCreds, envFound, err := api.ReadAwsEnvCredentials(prefix, getenv)
	if err == nil && envFound {
		info.Source = AwsCredSourceEnvVars
		info.HasSessionToken = envCreds.SessionToken != ""
		info.Region = envCreds.Region

		// Build list of env vars that contained credentials
		info.EnvVars = []string{
			prefix + "AWS_ACCESS_KEY_ID",
			prefix + "AWS_SECRET_ACCESS_KEY",
		}
		if envCreds.SessionToken != "" {
			info.EnvVars = append(info.EnvVars, prefix+"AWS_SESSION_TOKEN")
		}
		if envCreds.Region != "" {
			info.EnvVars = append(info.EnvVars, prefix+"AWS_REGION")
		}
		return envCreds, info, true
	}

	// 2. Check for AWS_PROFILE (named profile auth)
	if awsProfile := getenv("AWS_PROFILE"); awsProfile != "" {
		info.Source = AwsCredSourceProfile
		info.ProfileName = awsProfile
		info.Region = getenv("AWS_REGION")
		info.EnvVars = []string{"AWS_PROFILE"}
		if info.Region != "" {
			info.EnvVars = append(info.EnvVars, "AWS_REGION")
		}
		return api.AwsEnvCredentials{Region: info.Region}, info, true
	}

	// 3. Check for OIDC / Web Identity Token (common in CI/CD like GitHub Actions)
	awsRoleArn := getenv("AWS_ROLE_ARN")
	webIdentityTokenFile := getenv("AWS_WEB_IDENTITY_TOKEN_FILE")
	if awsRoleArn != "" && webIdentityTokenFile != "" {
		info.Source = AwsCredSourceOIDC
		info.RoleArn = awsRoleArn
		info.TokenFile = webIdentityTokenFile
		info.Region = getenv("AWS_REGION")
		info.EnvVars = []string{"AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"}
		if info.Region != "" {
			info.EnvVars = append(info.EnvVars, "AWS_REGION")
		}
		return api.AwsEnvCredentials{Region: info.Region}, info, true
	}

	// 4. Check for container credentials (ECS, CodeBuild, etc.)
	if containerCredsUri := getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"); containerCredsUri != "" {
		info.Source = AwsCredSourceContainerCreds
		info.Region = getenv("AWS_REGION")
		info.EnvVars = []string{"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"}
		if info.Region != "" {
			info.EnvVars = append(info.EnvVars, "AWS_REGION")
		}
		return api.AwsEnvCredentials{Region: info.Region}, info, true
	}
	if containerCredsFullUri := getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI"); containerCredsFullUri != "" {
		info.Source = AwsCredSourceContainerCreds
		info.Region = getenv("AWS_REGION")
		info.EnvVars = []string{"AWS_CONTAINER_CREDENTIALS_FULL_URI"}
		if info.Region != "" {
			info.EnvVars = append(info.EnvVars, "AWS_REGION")
		}
		return api.AwsEnvCredentials{Region: info.Region}, info, true
	}

	// Note: We don't check for IMDS (EC2 instance metadata) because that requires
	// making HTTP requests, which is slow and not suitable for test initialization.
	// The AWS SDK will automatically use IMDS as a fallback when running on EC2.

	return api.AwsEnvCredentials{}, AwsCredentialInfo{}, false
}

// formatCredentialSource returns a human-readable description of the credential source.
func formatCredentialSource(info AwsCredentialInfo) string {
	switch info.Source {
	case AwsCredSourceEnvVars:
		return "environment variables"
	case AwsCredSourceProfile:
		return fmt.Sprintf("AWS profile %q", info.ProfileName)
	case AwsCredSourceOIDC:
		return "OIDC web identity"
	case AwsCredSourceContainerCreds:
		return "container credentials"
	default:
		return "unknown source"
	}
}

// executeAwsAuth handles AwsAuth block execution in test mode.
// It looks for AWS credential environment variables (with optional prefix from the test step's env_prefix)
// and injects them into the session for dependent blocks to use.
// If no credentials are found, the block is marked as skipped.
func (e *TestExecutor) executeAwsAuth(block api.ParsedComponent, step TestStep, start time.Time) StepResult {
	result := StepResult{
		Block:          fmt.Sprintf("%s:%s", lowercaseFirst(string(BlockTypeAwsAuth)), block.ID),
		ExpectedStatus: step.Expect,
		Outputs:        make(map[string]string),
	}

	// Build a getenv function that consults testEnv first, then falls back to os.Getenv.
	// This ensures that env overrides from runbook_test.yml are respected during
	// credential detection (e.g., clearing AWS_PROFILE to force a skip).
	getenv := e.getenv

	// Get prefix from test step config (env_prefix field in runbook_test.yml)
	prefix := step.EnvPrefix

	// Detect credentials from all possible sources
	creds, credInfo, found := detectAwsCredentials(prefix, getenv)

	// If prefix was specified but no prefixed credentials found, try without prefix
	if !found && prefix != "" {
		if e.verbose {
			fmt.Printf("  No credentials found with prefix %q, trying standard vars...\n", prefix)
		}
		creds, credInfo, found = detectAwsCredentials("", getenv)
	}

	if !found {
		// No credentials found - skip this block
		if e.verbose {
			fmt.Printf("--- No AWS credentials found ---\n")
			fmt.Printf("  Checked sources:\n")
			if prefix != "" {
				fmt.Printf("    - Environment variables: %sAWS_ACCESS_KEY_ID + %sAWS_SECRET_ACCESS_KEY\n", prefix, prefix)
				fmt.Printf("    - Environment variables: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY\n")
			} else {
				fmt.Printf("    - Environment variables: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY\n")
			}
			fmt.Printf("    - AWS profile: AWS_PROFILE\n")
			fmt.Printf("    - OIDC: AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE\n")
			fmt.Printf("    - Container credentials: AWS_CONTAINER_CREDENTIALS_*_URI\n")
			fmt.Printf("--- Result: skipped (no credentials) ---\n")
		}

		e.blockStates[block.ID] = BlockStateSkipped
		result.ActualStatus = "skipped"
		result.Passed = e.matchesExpectedStatus(step.Expect, "skipped", 0)
		result.Duration = time.Since(start)
		return result
	}

	// Build per-block credentials map for awsAuthId support
	// This allows Check/Command blocks to reference specific auth block credentials
	blockCreds := make(map[string]string)

	// Inject credentials into session (using standard names) for dependent blocks
	// Only inject explicit credentials from env vars; profile/OIDC are resolved by the AWS SDK
	if credInfo.Source == AwsCredSourceEnvVars && creds.AccessKeyID != "" {
		envVars := map[string]string{
			"AWS_ACCESS_KEY_ID":     creds.AccessKeyID,
			"AWS_SECRET_ACCESS_KEY": creds.SecretAccessKey,
			// IMPORTANT: Always include AWS_SESSION_TOKEN even if empty to ensure proper
			// credential isolation. When switching from credentials that have a session token
			// (e.g., SSO, AssumeRole) to credentials that don't (e.g., IAM user), we must
			// explicitly clear the session token. Without this, the old session token would
			// be used with the new access key, causing InvalidToken errors.
			"AWS_SESSION_TOKEN": creds.SessionToken,
		}
		if creds.Region != "" {
			envVars["AWS_REGION"] = creds.Region
		}

		// Store per-block credentials for awsAuthId lookups
		for k, v := range envVars {
			blockCreds[k] = v
		}

		if err := e.session.AppendToEnv(envVars); err != nil {
			result.Passed = false
			result.ActualStatus = "error"
			result.Error = fmt.Sprintf("failed to inject AWS credentials: %v", err)
			result.Duration = time.Since(start)
			if e.verbose {
				fmt.Printf("--- Result: ✗ error ---\n")
				fmt.Printf("  Error: %s\n", result.Error)
			}
			return result
		}
	} else if credInfo.Source == AwsCredSourceProfile {
		// For profile auth, store the profile name so commands use it
		blockCreds["AWS_PROFILE"] = credInfo.ProfileName
		if credInfo.Region != "" {
			blockCreds["AWS_REGION"] = credInfo.Region
		}
	} else if credInfo.Source == AwsCredSourceOIDC {
		// For OIDC, store the role ARN and token file
		blockCreds["AWS_ROLE_ARN"] = credInfo.RoleArn
		blockCreds["AWS_WEB_IDENTITY_TOKEN_FILE"] = credInfo.TokenFile
		if credInfo.Region != "" {
			blockCreds["AWS_REGION"] = credInfo.Region
		}
	} else if credInfo.Source == AwsCredSourceContainerCreds {
		// For container creds, store the URI env vars
		for _, envVar := range credInfo.EnvVars {
			if val := getenv(envVar); val != "" {
				blockCreds[envVar] = val
			}
		}
		if credInfo.Region != "" {
			blockCreds["AWS_REGION"] = credInfo.Region
		}
	}

	// Store credentials for this auth block
	e.authBlockCredentials[block.ID] = blockCreds

	// Credentials found - mark success
	e.blockStates[block.ID] = BlockStateSuccess
	result.ActualStatus = "success"
	result.Passed = e.matchesExpectedStatus(step.Expect, "success", 0)
	result.Duration = time.Since(start)

	if e.verbose {
		fmt.Printf("--- AWS credentials found ---\n")
		fmt.Printf("  Source: %s\n", formatCredentialSource(credInfo))

		switch credInfo.Source {
		case AwsCredSourceEnvVars:
			fmt.Printf("  Environment variables:\n")
			for _, envVar := range credInfo.EnvVars {
				if strings.Contains(envVar, "ACCESS_KEY_ID") && creds.AccessKeyID != "" {
					fmt.Printf("    %s = %s\n", envVar, maskAccessKeyID(creds.AccessKeyID))
				} else if strings.Contains(envVar, "SECRET") {
					fmt.Printf("    %s = (set)\n", envVar)
				} else if strings.Contains(envVar, "SESSION_TOKEN") {
					fmt.Printf("    %s = (set)\n", envVar)
				} else if strings.Contains(envVar, "REGION") {
					fmt.Printf("    %s = %s\n", envVar, credInfo.Region)
				} else {
					fmt.Printf("    %s\n", envVar)
				}
			}
			if credInfo.HasSessionToken {
				fmt.Printf("  Credential type: temporary (has session token)\n")
			} else {
				fmt.Printf("  Credential type: long-term (no session token)\n")
			}
			fmt.Printf("  Injected into session: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY")
			if credInfo.HasSessionToken {
				fmt.Printf(", AWS_SESSION_TOKEN")
			}
			if credInfo.Region != "" {
				fmt.Printf(", AWS_REGION")
			}
			fmt.Printf("\n")

		case AwsCredSourceProfile:
			fmt.Printf("  Profile: %s\n", credInfo.ProfileName)
			fmt.Printf("  Environment variable: AWS_PROFILE\n")
			if credInfo.Region != "" {
				fmt.Printf("  Region: %s (from AWS_REGION)\n", credInfo.Region)
			}
			fmt.Printf("  Note: AWS SDK will resolve credentials from profile\n")

		case AwsCredSourceOIDC:
			fmt.Printf("  Role ARN: %s\n", credInfo.RoleArn)
			fmt.Printf("  Token file: %s\n", credInfo.TokenFile)
			fmt.Printf("  Environment variables: AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE\n")
			if credInfo.Region != "" {
				fmt.Printf("  Region: %s (from AWS_REGION)\n", credInfo.Region)
			}
			fmt.Printf("  Note: AWS SDK will assume role using web identity token\n")

		case AwsCredSourceContainerCreds:
			fmt.Printf("  Environment variables: %s\n", strings.Join(credInfo.EnvVars, ", "))
			if credInfo.Region != "" {
				fmt.Printf("  Region: %s (from AWS_REGION)\n", credInfo.Region)
			}
			fmt.Printf("  Note: AWS SDK will retrieve credentials from container metadata\n")
		}

		fmt.Printf("--- Result: ✓ success ---\n")
	}

	return result
}

// maskAccessKeyID returns a masked version of an AWS access key ID for safe logging.
// For keys with 8+ characters, it shows the first 4 and last 4 characters.
// For shorter keys, it safely truncates to avoid slice index panics.
func maskAccessKeyID(key string) string {
	n := len(key)
	switch {
	case n >= 8:
		return fmt.Sprintf("%s...%s", key[:4], key[n-4:])
	case n >= 4:
		// Show first 2 and last 2 for medium-length keys
		return fmt.Sprintf("%s...%s", key[:2], key[n-2:])
	case n > 0:
		// Very short key - just show it's present but masked
		return fmt.Sprintf("%s...", key[:1])
	default:
		return ""
	}
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

	// Set environment using the same helper as the runtime server
	cmd.Env = execCtx.Env
	cmd.Env = api.SetupExecEnvVars(cmd.Env, outputFilePath, filesDir, e.activeWorkTreePath)

	// Add test-specific environment variables
	for key, value := range e.testEnv {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", key, value))
	}

	// Inject auth block credentials if this block has an auth dependency (awsAuthId/githubAuthId)
	// This ensures the block uses credentials from the specific auth block, not just the session
	// We use api.MergeEnvVars to properly REPLACE existing env vars rather than append duplicates.
	// This is critical for proper credential isolation - when switching between auth blocks,
	// we need to fully replace the old credentials including clearing AWS_SESSION_TOKEN if
	// the new credentials don't have one.
	if authDep, hasAuthDep := e.authDeps[executable.ComponentID]; hasAuthDep {
		if authCreds, hasCreds := e.authBlockCredentials[authDep.AuthBlockID]; hasCreds {
			cmd.Env = api.MergeEnvVars(cmd.Env, authCreds)
		}
	}

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

	// Determine status using the same logic as the runtime server
	exitCode, status := api.DetermineExitStatus(waitErr, ctx)
	if status == "fail" && ctx.Err() == context.DeadlineExceeded {
		return "timeout", -1, nil, logs, fmt.Errorf("script execution timed out")
	}

	// Parse outputs using the same parser as the runtime server
	outputs := make(map[string]string)
	if status == "success" || status == "warn" {
		outputs, _ = api.ParseBlockOutputs(outputFilePath)
	}

	// Capture environment changes from bash scripts and update session
	if status == "success" || status == "warn" {
		if err := scriptSetup.CaptureEnvironmentChanges(e.session, execCtx.WorkDir); err != nil {
			slog.Warn("Failed to update session environment", "error", err)
		}
	}

	// Copy captured files to output directory using the same function as the runtime server
	if status == "success" || status == "warn" {
		resolvedOutputPath := e.resolveOutputPath()
		if _, captureErr := api.CaptureFilesFromDir(filesDir, resolvedOutputPath); captureErr != nil {
			slog.Warn("Failed to capture files", "error", captureErr)
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

