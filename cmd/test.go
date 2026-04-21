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

	gruntbookapi "github.com/gruntwork-io/runbooks/api"
	runbooktesting "github.com/gruntwork-io/runbooks/api/testing"

	"github.com/spf13/cobra"
)

var (
	// Test command flags
	testVerbose             bool
	testShowBoilerplateLogs bool
	testTestName            string
	testOutputFormat        string
	testOutputFile          string
	testMaxParallel         int
)

// testCmd represents the test command
var testCmd = &cobra.Command{
	Use:     "test <gruntbook-path>",
	Short:   "Run automated tests for gruntbooks",
	Long:    `Run automated tests for gruntbooks defined in gruntbook_test.yml files.`,
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

	// Discover gruntbooks from args
	gruntbooks, err := discoverGruntbooks(args)
	if err != nil {
		return fmt.Errorf("failed to discover gruntbooks: %w", err)
	}

	if len(gruntbooks) == 0 {
		return fmt.Errorf("no gruntbooks found matching %v", args)
	}

	// Run tests
	suites := runTestSuites(gruntbooks)

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

// discoverGruntbooks finds gruntbooks based on the provided paths.
// Supports:
// - Direct path to gruntbook.mdx file
// - Directory containing gruntbook.mdx
// - Glob pattern ending in /... to recursively find gruntbooks
func discoverGruntbooks(paths []string) ([]string, error) {
	var gruntbooks []string
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
				base := filepath.Base(path)
				if base == "gruntbook.mdx" || base == "runbook.mdx" {
					dir := filepath.Dir(path)
					// If a gruntbook.mdx sibling exists, skip the legacy runbook.mdx to avoid duplicates.
					if base == "runbook.mdx" {
						if _, err := os.Stat(filepath.Join(dir, "gruntbook.mdx")); err == nil {
							return nil
						}
					}
					if _, ok := findTestConfigFile(dir); ok {
						absPath, _ := filepath.Abs(path)
						if !seen[absPath] {
							seen[absPath] = true
							gruntbooks = append(gruntbooks, absPath)
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

		var gruntbookPath string
		if info.IsDir() {
			resolved, err := gruntbookapi.ResolveGruntbookPath(pattern)
			if err != nil {
				return nil, fmt.Errorf("gruntbook not found in directory %s: %w", pattern, err)
			}
			gruntbookPath = resolved
		} else {
			gruntbookPath = pattern
		}

		// Verify gruntbook exists
		if _, err := os.Stat(gruntbookPath); err != nil {
			return nil, fmt.Errorf("gruntbook not found: %s", gruntbookPath)
		}

		// Check for test config
		dir := filepath.Dir(gruntbookPath)
		if _, ok := findTestConfigFile(dir); !ok {
			fmt.Printf("Warning: no gruntbook_test.yml found for %s, skipping\n", gruntbookPath)
			continue
		}

		absPath, _ := filepath.Abs(gruntbookPath)
		if !seen[absPath] {
			seen[absPath] = true
			gruntbooks = append(gruntbooks, absPath)
		}
	}

	return gruntbooks, nil
}

// runTestSuites runs tests for all discovered gruntbooks.
func runTestSuites(gruntbooks []string) []runbooktesting.GruntbookTestSuite {
	// Group gruntbooks by parallelizable status
	var parallelizable []string
	var sequential []string

	for _, gruntbook := range gruntbooks {
		config, err := loadTestConfig(gruntbook)
		if err != nil {
			fmt.Printf("Error loading config for %s: %v\n", gruntbook, err)
			continue
		}
		if config.Settings.IsParallelizable() {
			parallelizable = append(parallelizable, gruntbook)
		} else {
			sequential = append(sequential, gruntbook)
		}
	}

	var suites []runbooktesting.GruntbookTestSuite

	// Run parallelizable gruntbooks concurrently
	if len(parallelizable) > 0 {
		maxWorkers := testMaxParallel
		if maxWorkers <= 0 {
			maxWorkers = 4 // Default
		}
		if maxWorkers > len(parallelizable) {
			maxWorkers = len(parallelizable)
		}

		results := make(chan runbooktesting.GruntbookTestSuite, len(parallelizable))
		work := make(chan string, len(parallelizable))

		// Start workers
		var wg sync.WaitGroup
		for i := 0; i < maxWorkers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for gruntbook := range work {
					results <- runTestSuite(gruntbook)
				}
			}()
		}

		// Send work
		for _, gruntbook := range parallelizable {
			work <- gruntbook
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

	// Run sequential gruntbooks one at a time
	for _, gruntbook := range sequential {
		suites = append(suites, runTestSuite(gruntbook))
	}

	return suites
}

// runTestSuite runs all tests for a single gruntbook.
func runTestSuite(gruntbookPath string) runbooktesting.GruntbookTestSuite {
	start := time.Now()
	suite := runbooktesting.GruntbookTestSuite{
		GruntbookPath: gruntbookPath,
	}

	config, err := loadTestConfig(gruntbookPath)
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
	workDir, cleanupWorkDir, err := resolveTestWorkDir(gruntbookPath, config)
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
	executor, err := createExecutor(gruntbookPath, workDir, outputPath, config.Settings.GetTimeout())
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

	// Print gruntbook header in verbose mode
	executor.PrintGruntbookHeader()

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

// loadTestConfig loads the test configuration for a gruntbook.
func loadTestConfig(gruntbookPath string) (*runbooktesting.TestConfig, error) {
	dir := filepath.Dir(gruntbookPath)
	configPath, ok := findTestConfigFile(dir)
	if !ok {
		configPath = filepath.Join(dir, "gruntbook_test.yml")
	}
	return runbooktesting.LoadConfig(configPath)
}

// findTestConfigFile looks for a test config file in the given directory,
// preferring gruntbook_test.yml over the legacy runbook_test.yml name.
// Returns the path and true if found.
func findTestConfigFile(dir string) (string, bool) {
	primary := filepath.Join(dir, "gruntbook_test.yml")
	if _, err := os.Stat(primary); err == nil {
		return primary, true
	}
	legacy := filepath.Join(dir, "runbook_test.yml")
	if _, err := os.Stat(legacy); err == nil {
		slog.Warn("Using legacy runbook_test.yml filename; rename to gruntbook_test.yml", "path", legacy)
		return legacy, true
	}
	return "", false
}

// resolveTestWorkDir determines the working directory for test execution based on config settings.
// Precedence: use_temp_working_dir > working_dir > current directory
// Returns the absolute working directory path, a cleanup function (nil if no cleanup needed), and an error.
func resolveTestWorkDir(gruntbookPath string, config *runbooktesting.TestConfig) (string, func(), error) {
	// Check if temp working directory is requested (highest precedence)
	if config.Settings.ShouldUseTempWorkingDir() {
		dir, err := os.MkdirTemp("", "gruntbook-workdir-*")
		if err != nil {
			return "", nil, fmt.Errorf("failed to create temp working directory: %w", err)
		}
		return dir, func() { os.RemoveAll(dir) }, nil
	}

	// Check for configured working directory
	configuredWorkDir := config.Settings.GetWorkingDir()
	if configuredWorkDir != "" {
		if configuredWorkDir == "." {
			// "." means gruntbook directory
			return filepath.Dir(gruntbookPath), nil, nil
		}
		if filepath.IsAbs(configuredWorkDir) {
			return configuredWorkDir, nil, nil
		}
		// Relative path - resolve relative to gruntbook directory
		return filepath.Join(filepath.Dir(gruntbookPath), configuredWorkDir), nil, nil
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
func createExecutor(gruntbookPath, workDir, outputPath string, timeout time.Duration) (*runbooktesting.TestExecutor, error) {
	opts := []runbooktesting.ExecutorOption{
		runbooktesting.WithTimeout(timeout),
		runbooktesting.WithVerbose(testVerbose),
	}
	return runbooktesting.NewTestExecutor(gruntbookPath, workDir, outputPath, opts...)
}

// reportResults prints test results to stdout or file.
func reportResults(suites []runbooktesting.GruntbookTestSuite) {
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
