package cmd

import (
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	runbooktesting "runbooks/api/testing"

	bpUtil "github.com/gruntwork-io/boilerplate/util"
	"github.com/spf13/cobra"
)

var (
	// Test command flags
	testVerbose            bool
	testShowBoilerplateLogs bool
	testTestName           string
	testOutputFormat       string
	testOutputFile         string
	testMaxParallel        int
)

// testCmd represents the test command
var testCmd = &cobra.Command{
	Use:     "test <runbook-path>",
	Short:   "Run automated tests for runbooks",
	Long:    `Run automated tests for runbooks defined in runbook_test.yml files.`,
	GroupID: "other",
	Args:    cobra.MinimumNArgs(1),
	RunE:    runTest,
}

func init() {
	rootCmd.AddCommand(testCmd)

	// Test-specific flags
	testCmd.Flags().BoolVarP(&testVerbose, "verbose", "v", false, "Enable verbose output (show script output)")
	testCmd.Flags().BoolVar(&testShowBoilerplateLogs, "show-boilerplate-logs", false, "Show boilerplate library logs (requires -v)")
	testCmd.Flags().StringVar(&testTestName, "test", "", "Run only the specified test case")
	testCmd.Flags().StringVar(&testOutputFormat, "output", "text", "Output format (text or junit)")
	testCmd.Flags().StringVar(&testOutputFile, "output-file", "", "Write output to file (for junit format)")
	testCmd.Flags().IntVar(&testMaxParallel, "max-parallel", 0, "Maximum number of parallel test executions (0 = auto)")
}

// runTest runs the test command
func runTest(cmd *cobra.Command, args []string) error {
	// Suppress boilerplate logs unless explicitly requested
	// Even in verbose mode, we suppress them by default for cleaner output
	if !testShowBoilerplateLogs {
		suppressBoilerplateLogs()
	}

	// Suppress all logs if not in verbose mode
	if !testVerbose {
		suppressAllLogs()
	}

	// Discover runbooks from args
	runbooks, err := discoverRunbooks(args)
	if err != nil {
		return fmt.Errorf("failed to discover runbooks: %w", err)
	}

	if len(runbooks) == 0 {
		return fmt.Errorf("no runbooks found matching %v", args)
	}

	// Run tests
	suites := runTestSuites(runbooks)

	// Report results
	reportResults(suites)

	// Determine exit code
	var failed int
	for _, suite := range suites {
		failed += suite.Failed
	}

	if failed > 0 {
		os.Exit(1)
	}

	return nil
}

// discoverRunbooks finds runbooks based on the provided paths.
// Supports:
// - Direct path to runbook.mdx file
// - Directory containing runbook.mdx
// - Glob pattern ending in /... to recursively find runbooks
func discoverRunbooks(paths []string) ([]string, error) {
	var runbooks []string
	seen := make(map[string]bool)

	for _, pattern := range paths {
		// Handle recursive glob (./path/...)
		if strings.HasSuffix(pattern, "/...") {
			basePath := strings.TrimSuffix(pattern, "/...")
			if basePath == "" || basePath == "." {
				basePath = "."
			}

			err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return nil // Skip errors
				}
				if info.IsDir() {
					return nil
				}
				if filepath.Base(path) == "runbook.mdx" {
					// Check for runbook_test.yml
					dir := filepath.Dir(path)
					testConfigPath := filepath.Join(dir, "runbook_test.yml")
					if _, err := os.Stat(testConfigPath); err == nil {
						absPath, _ := filepath.Abs(path)
						if !seen[absPath] {
							seen[absPath] = true
							runbooks = append(runbooks, absPath)
						}
					}
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
			continue
		}

		// Handle direct path
		info, err := os.Stat(pattern)
		if err != nil {
			return nil, fmt.Errorf("path not found: %s", pattern)
		}

		var runbookPath string
		if info.IsDir() {
			// Look for runbook.mdx in directory
			runbookPath = filepath.Join(pattern, "runbook.mdx")
		} else {
			runbookPath = pattern
		}

		// Verify runbook exists
		if _, err := os.Stat(runbookPath); err != nil {
			return nil, fmt.Errorf("runbook not found: %s", runbookPath)
		}

		// Check for test config
		dir := filepath.Dir(runbookPath)
		testConfigPath := filepath.Join(dir, "runbook_test.yml")
		if _, err := os.Stat(testConfigPath); err != nil {
			fmt.Printf("Warning: no runbook_test.yml found for %s, skipping\n", runbookPath)
			continue
		}

		absPath, _ := filepath.Abs(runbookPath)
		if !seen[absPath] {
			seen[absPath] = true
			runbooks = append(runbooks, absPath)
		}
	}

	return runbooks, nil
}

// runTestSuites runs tests for all discovered runbooks.
func runTestSuites(runbooks []string) []runbooktesting.RunbookTestSuite {
	// Group runbooks by parallelizable status
	var parallelizable []string
	var sequential []string

	for _, runbook := range runbooks {
		config, err := loadTestConfig(runbook)
		if err != nil {
			fmt.Printf("Error loading config for %s: %v\n", runbook, err)
			continue
		}
		if config.Settings.IsParallelizable() {
			parallelizable = append(parallelizable, runbook)
		} else {
			sequential = append(sequential, runbook)
		}
	}

	var suites []runbooktesting.RunbookTestSuite

	// Run parallelizable runbooks concurrently
	if len(parallelizable) > 0 {
		maxWorkers := testMaxParallel
		if maxWorkers <= 0 {
			maxWorkers = 4 // Default
		}
		if maxWorkers > len(parallelizable) {
			maxWorkers = len(parallelizable)
		}

		results := make(chan runbooktesting.RunbookTestSuite, len(parallelizable))
		work := make(chan string, len(parallelizable))

		// Start workers
		var wg sync.WaitGroup
		for i := 0; i < maxWorkers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for runbook := range work {
					results <- runTestSuite(runbook)
				}
			}()
		}

		// Send work
		for _, runbook := range parallelizable {
			work <- runbook
		}
		close(work)

		// Wait for completion
		wg.Wait()
		close(results)

		// Collect results
		for suite := range results {
			suites = append(suites, suite)
		}
	}

	// Run sequential runbooks one at a time
	for _, runbook := range sequential {
		suites = append(suites, runTestSuite(runbook))
	}

	return suites
}

// runTestSuite runs all tests for a single runbook.
func runTestSuite(runbookPath string) runbooktesting.RunbookTestSuite {
	start := time.Now()
	suite := runbooktesting.RunbookTestSuite{
		RunbookPath: runbookPath,
	}

	config, err := loadTestConfig(runbookPath)
	if err != nil {
		suite.Results = append(suite.Results, runbooktesting.TestResult{
			TestCase: "config",
			Status:   runbooktesting.TestFailed,
			Error:    fmt.Sprintf("failed to load config: %v", err),
		})
		suite.Failed = 1
		suite.Duration = time.Since(start)
		return suite
	}

	// Determine working directory using the unified model
	// Precedence: use_temp_working_dir > working_dir > current directory
	workDir, cleanupWorkDir, err := resolveTestWorkDir(runbookPath, config)
	if err != nil {
		suite.Results = append(suite.Results, runbooktesting.TestResult{
			TestCase: "setup",
			Status:   runbooktesting.TestFailed,
			Error:    err.Error(),
		})
		suite.Failed = 1
		suite.Duration = time.Since(start)
		return suite
	}
	if cleanupWorkDir != nil {
		defer cleanupWorkDir()
	}

	// Get output path from config (relative to working directory)
	outputPath := config.Settings.GetOutputPath()

	// Create executor with unified working directory model
	executor, err := createExecutor(runbookPath, workDir, outputPath, config.Settings.GetTimeout())
	if err != nil {
		suite.Results = append(suite.Results, runbooktesting.TestResult{
			TestCase: "setup",
			Status:   runbooktesting.TestFailed,
			Error:    fmt.Sprintf("failed to create executor: %v", err),
		})
		suite.Failed = 1
		suite.Duration = time.Since(start)
		return suite
	}
	defer executor.Close()

	// Print runbook header in verbose mode
	executor.PrintRunbookHeader()

	// Run each test case
	for _, tc := range config.Tests {
		// Skip if a specific test was requested and this isn't it
		if testTestName != "" && tc.Name != testTestName {
			continue
		}

		// Print test header in verbose mode
		executor.PrintTestHeader(tc.Name)

		result := executor.RunTest(tc)
		suite.Results = append(suite.Results, result)

		switch result.Status {
		case runbooktesting.TestPassed:
			suite.Passed++
		case runbooktesting.TestFailed:
			suite.Failed++
		case runbooktesting.TestSkipped:
			suite.Skipped++
		}
	}

	suite.Duration = time.Since(start)
	return suite
}

// loadTestConfig loads the test configuration for a runbook.
func loadTestConfig(runbookPath string) (*runbooktesting.TestConfig, error) {
	dir := filepath.Dir(runbookPath)
	configPath := filepath.Join(dir, "runbook_test.yml")
	return runbooktesting.LoadConfig(configPath)
}

// resolveTestWorkDir determines the working directory for test execution based on config settings.
// Precedence: use_temp_working_dir > working_dir > current directory
// Returns the absolute working directory path, a cleanup function (nil if no cleanup needed), and an error.
func resolveTestWorkDir(runbookPath string, config *runbooktesting.TestConfig) (string, func(), error) {
	// Check if temp working directory is requested (highest precedence)
	if config.Settings.ShouldUseTempWorkingDir() {
		dir, err := os.MkdirTemp("", "runbook-workdir-*")
		if err != nil {
			return "", nil, fmt.Errorf("failed to create temp working directory: %w", err)
		}
		return dir, func() { os.RemoveAll(dir) }, nil
	}

	// Check for configured working directory
	configuredWorkDir := config.Settings.GetWorkingDir()
	if configuredWorkDir != "" {
		if configuredWorkDir == "." {
			// "." means runbook directory
			return filepath.Dir(runbookPath), nil, nil
		}
		if filepath.IsAbs(configuredWorkDir) {
			return configuredWorkDir, nil, nil
		}
		// Relative path - resolve relative to runbook directory
		return filepath.Join(filepath.Dir(runbookPath), configuredWorkDir), nil, nil
	}

	// Default: current directory (where CLI was launched)
	cwd, err := os.Getwd()
	if err != nil {
		return "", nil, fmt.Errorf("failed to get current working directory: %w", err)
	}
	return cwd, nil, nil
}

// createExecutor creates a test executor with the given configuration.
// workDir is the base working directory for script execution.
// outputPath is the output path relative to workDir (default: "generated").
func createExecutor(runbookPath, workDir, outputPath string, timeout time.Duration) (*runbooktesting.TestExecutor, error) {
	opts := []runbooktesting.ExecutorOption{
		runbooktesting.WithTimeout(timeout),
		runbooktesting.WithVerbose(testVerbose),
	}
	return runbooktesting.NewTestExecutor(runbookPath, workDir, outputPath, opts...)
}

// reportResults prints test results to stdout or file.
func reportResults(suites []runbooktesting.RunbookTestSuite) {
	var reporter runbooktesting.Reporter

	switch testOutputFormat {
	case "junit":
		reporter = runbooktesting.NewJUnitReporter(os.Stdout)
	default:
		reporter = runbooktesting.NewTextReporter(os.Stdout, testVerbose)
	}

	// If output file specified, write to file
	if testOutputFile != "" {
		if err := runbooktesting.ReportToFile(reporter, suites, testOutputFile); err != nil {
			fmt.Fprintf(os.Stderr, "Error writing to output file: %v\n", err)
			// Fall back to stdout
			reporter.Report(suites)
		}
		return
	}

	reporter.Report(suites)
}

// suppressBoilerplateLogs disables output from the boilerplate library's loggers.
// This keeps the output clean while still allowing script output to be shown.
func suppressBoilerplateLogs() {
	// Suppress boilerplate library's custom logger
	bpUtil.Logger.SetOutput(io.Discard)

	// Suppress slog output (used by boilerplate rendering)
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// suppressAllLogs disables all log output including standard library log.
func suppressAllLogs() {
	// Suppress standard library log output
	log.SetOutput(io.Discard)
	log.SetFlags(0)
	log.SetPrefix("")
}
