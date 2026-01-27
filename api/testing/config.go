// Package testing provides the runbook testing framework.
// It enables automated testing of runbooks via the `runbooks test` CLI command.
package testing

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// TestConfig represents the complete test configuration for a runbook.
// This is parsed from runbook_test.yml files.
type TestConfig struct {
	Version  int            `yaml:"version"`
	Settings TestSettings   `yaml:"settings,omitempty"`
	Tests    []TestCase     `yaml:"tests"`
}

// TestSettings contains global settings for all tests in this config.
type TestSettings struct {
	// UseTempOutput generates files to a temporary directory (default: true)
	UseTempOutput bool `yaml:"use_temp_output,omitempty"`
	// WorkingDir sets the working directory for script execution.
	// If empty (default), a temp directory is used. Use "." for the runbook directory.
	WorkingDir string `yaml:"working_dir,omitempty"`
	// Timeout for each test case (default: 5m)
	Timeout string `yaml:"timeout,omitempty"`
	// Parallelizable indicates if this runbook's tests can run in parallel with other runbooks
	Parallelizable *bool `yaml:"parallelizable,omitempty"`
}

// TestCase represents a single test case within a test config.
type TestCase struct {
	Name        string                 `yaml:"name"`
	Description string                 `yaml:"description,omitempty"`
	Inputs      map[string]InputValue  `yaml:"inputs,omitempty"`
	Steps       []TestStep             `yaml:"steps,omitempty"`
	Assertions  []TestAssertion        `yaml:"assertions,omitempty"`
	Cleanup     []CleanupAction        `yaml:"cleanup,omitempty"`
}

// TestStep represents a single step in a test case.
type TestStep struct {
	Block          string          `yaml:"block"`                     // Block ID to execute
	Expect         ExpectedStatus  `yaml:"expect"`                    // Expected execution status
	Outputs        []string        `yaml:"outputs,omitempty"`         // Output names to capture
	MissingOutputs []string        `yaml:"missing_outputs,omitempty"` // Expected missing outputs (for blocked status)
	ErrorContains  string          `yaml:"error_contains,omitempty"`  // Expected error message substring (for config_error status)
	Assertions     []TestAssertion `yaml:"assertions,omitempty"`      // Per-step assertions
}

// ExpectedStatus represents the expected status of a block execution.
type ExpectedStatus string

const (
	StatusSuccess     ExpectedStatus = "success"
	StatusFail        ExpectedStatus = "fail"
	StatusWarn        ExpectedStatus = "warn"
	StatusBlocked     ExpectedStatus = "blocked"
	StatusSkip        ExpectedStatus = "skip"
	StatusConfigError ExpectedStatus = "config_error"
)

// TestAssertion represents an assertion to validate test results.
type TestAssertion struct {
	Type AssertionType `yaml:"type"`

	// File assertions
	Path     string `yaml:"path,omitempty"`     // Path for file assertions
	Contains string `yaml:"contains,omitempty"` // Substring to check for file_contains
	Pattern  string `yaml:"pattern,omitempty"`  // Regex pattern for file_matches

	// Output assertions
	Block  string `yaml:"block,omitempty"`  // Block ID for output assertions
	Output string `yaml:"output,omitempty"` // Output name to check
	Value  string `yaml:"value,omitempty"`  // Expected value for output_equals

	// files_generated assertion
	MinCount int `yaml:"min_count,omitempty"` // Minimum files generated

	// Script assertion
	Command string `yaml:"command,omitempty"` // Script command to run
}

// AssertionType represents the type of assertion.
type AssertionType string

const (
	AssertionFileExists       AssertionType = "file_exists"
	AssertionFileNotExists    AssertionType = "file_not_exists"
	AssertionFileContains     AssertionType = "file_contains"
	AssertionFileNotContains  AssertionType = "file_not_contains"
	AssertionFileMatches      AssertionType = "file_matches"
	AssertionFileEquals       AssertionType = "file_equals"
	AssertionOutputEquals     AssertionType = "output_equals"
	AssertionOutputMatches    AssertionType = "output_matches"
	AssertionOutputExists     AssertionType = "output_exists"
	AssertionFilesGenerated   AssertionType = "files_generated"
	AssertionScript           AssertionType = "script"
	AssertionDirExists        AssertionType = "dir_exists"
	AssertionDirNotExists     AssertionType = "dir_not_exists"
)

// CleanupAction represents a cleanup action to run after a test.
type CleanupAction struct {
	Command string `yaml:"command,omitempty"` // Inline command to run
	Path    string `yaml:"path,omitempty"`    // Path to script file
}

// InputValue represents an input value that can be either a literal or a fuzz config.
// In YAML, it can be specified as:
//   - Literal: `inputs.varName: "literal-value"`
//   - Fuzz: `inputs.varName: { fuzz: { type: string, minLength: 5 } }`
type InputValue struct {
	Literal interface{}
	Fuzz    *FuzzConfig
}

// UnmarshalYAML implements custom YAML unmarshaling for InputValue.
func (v *InputValue) UnmarshalYAML(value *yaml.Node) error {
	// Try to unmarshal as a fuzz config wrapper first
	var fuzzWrapper struct {
		Fuzz *FuzzConfig `yaml:"fuzz"`
	}
	if err := value.Decode(&fuzzWrapper); err == nil && fuzzWrapper.Fuzz != nil {
		v.Fuzz = fuzzWrapper.Fuzz
		return nil
	}

	// Otherwise, treat as a literal value
	var literal interface{}
	if err := value.Decode(&literal); err != nil {
		return err
	}
	v.Literal = literal
	return nil
}

// IsLiteral returns true if this input value is a literal (not a fuzz config).
func (v InputValue) IsLiteral() bool {
	return v.Fuzz == nil
}

// FuzzConfig represents a fuzz value configuration for an input.
type FuzzConfig struct {
	Type FuzzType `yaml:"type"`

	// String constraints
	Length    int    `yaml:"length,omitempty"`    // Exact length
	MinLength int    `yaml:"minLength,omitempty"` // Minimum length
	MaxLength int    `yaml:"maxLength,omitempty"` // Maximum length
	Pattern   string `yaml:"pattern,omitempty"`   // Regex pattern (for validation reference)
	Prefix    string `yaml:"prefix,omitempty"`    // Prefix to add
	Suffix    string `yaml:"suffix,omitempty"`    // Suffix to add

	// Character options for string type
	IncludeSpaces       bool `yaml:"includeSpaces,omitempty"`
	IncludeSpecialChars bool `yaml:"includeSpecialChars,omitempty"`

	// Numeric constraints
	Min int `yaml:"min,omitempty"` // Minimum value (for int/float)
	Max int `yaml:"max,omitempty"` // Maximum value (for int/float)

	// Enum options
	Options []string `yaml:"options,omitempty"`

	// Email/URL options
	Domain string `yaml:"domain,omitempty"` // Domain for email/url generation

	// Date/timestamp options
	MinDate string `yaml:"minDate,omitempty"` // Minimum date (for date/timestamp)
	MaxDate string `yaml:"maxDate,omitempty"` // Maximum date (for date/timestamp)
	Format  string `yaml:"format,omitempty"`  // Date format

	// Words options
	WordCount    int `yaml:"wordCount,omitempty"`
	MinWordCount int `yaml:"minWordCount,omitempty"`
	MaxWordCount int `yaml:"maxWordCount,omitempty"`

	// List options
	Count    int `yaml:"count,omitempty"`    // Exact number of items
	MinCount int `yaml:"minCount,omitempty"` // Minimum number of items
	MaxCount int `yaml:"maxCount,omitempty"` // Maximum number of items

	// Schema for nested maps (x-schema fields)
	Schema []string `yaml:"schema,omitempty"` // Field names for nested map values
}

// FuzzType represents the type of fuzz value to generate.
type FuzzType string

const (
	FuzzString    FuzzType = "string"    // Alphanumeric string (default)
	FuzzInt       FuzzType = "int"       // Integer
	FuzzFloat     FuzzType = "float"     // Float
	FuzzBool      FuzzType = "bool"      // Boolean
	FuzzEnum      FuzzType = "enum"      // Pick from options
	FuzzEmail     FuzzType = "email"     // Valid email format
	FuzzURL       FuzzType = "url"       // Valid URL format
	FuzzUUID      FuzzType = "uuid"      // UUID v4
	FuzzDate      FuzzType = "date"      // Date (YYYY-MM-DD)
	FuzzTimestamp FuzzType = "timestamp" // ISO timestamp
	FuzzWords     FuzzType = "words"     // Random words
	FuzzList      FuzzType = "list"      // List of strings (JSON format)
	FuzzMap       FuzzType = "map"       // Map of string keys to string values (JSON format)
)

// TestResult represents the result of running a test case.
type TestResult struct {
	TestCase    string        `json:"testCase"`
	Status      TestStatus    `json:"status"`
	Duration    time.Duration `json:"duration"`
	Error       string        `json:"error,omitempty"`
	StepResults []StepResult  `json:"stepResults,omitempty"`
	Assertions  []AssertionResult `json:"assertions,omitempty"`
}

// TestStatus represents the overall status of a test.
type TestStatus string

const (
	TestPassed  TestStatus = "passed"
	TestFailed  TestStatus = "failed"
	TestSkipped TestStatus = "skipped"
)

// StepResult represents the result of executing a single test step.
type StepResult struct {
	Block            string                `json:"block"`
	ExpectedStatus   ExpectedStatus        `json:"expectedStatus"`
	ActualStatus     string                `json:"actualStatus"`
	ExitCode         int                   `json:"exitCode"`
	Passed           bool                  `json:"passed"`
	Error            string                `json:"error,omitempty"`
	ErrorDisplayed   bool                  `json:"-"` // True if error was shown in verbose block detail
	Outputs          map[string]string     `json:"outputs,omitempty"`
	Logs             string                `json:"logs,omitempty"`
	Duration         time.Duration         `json:"duration"`
	AssertionResults []AssertionResult     `json:"assertionResults,omitempty"`
}

// AssertionResult represents the result of an assertion.
type AssertionResult struct {
	Type    AssertionType `json:"type"`
	Passed  bool          `json:"passed"`
	Message string        `json:"message,omitempty"`
}

// RunbookTestSuite represents all test results for a runbook.
type RunbookTestSuite struct {
	RunbookPath string        `json:"runbookPath"`
	Duration    time.Duration `json:"duration"`
	Results     []TestResult  `json:"results"`
	Passed      int           `json:"passed"`
	Failed      int           `json:"failed"`
	Skipped     int           `json:"skipped"`
}

// LoadConfig loads a test configuration from a YAML file.
func LoadConfig(path string) (*TestConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	return ParseConfig(data)
}

// ParseConfig parses a test configuration from YAML bytes.
func ParseConfig(data []byte) (*TestConfig, error) {
	var config TestConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	// Apply defaults
	applyDefaults(&config)

	// Validate the config
	if err := validateConfig(&config); err != nil {
		return nil, err
	}

	return &config, nil
}

// applyDefaults applies default values to the config.
func applyDefaults(config *TestConfig) {
	// Default version to 1
	if config.Version == 0 {
		config.Version = 1
	}

	// Default settings
	if config.Settings.Timeout == "" {
		config.Settings.Timeout = "5m"
	}

	// UseTempOutput defaults to true (but we need to check if it was explicitly set)
	// Since bool defaults to false, we use a sentinel approach in validation

	// Default parallelizable to true
	if config.Settings.Parallelizable == nil {
		defaultTrue := true
		config.Settings.Parallelizable = &defaultTrue
	}

	// Default each step's expect to success
	for i := range config.Tests {
		for j := range config.Tests[i].Steps {
			if config.Tests[i].Steps[j].Expect == "" {
				config.Tests[i].Steps[j].Expect = StatusSuccess
			}
		}
	}
}

// validateConfig validates the test configuration.
func validateConfig(config *TestConfig) error {
	if config.Version != 1 {
		return fmt.Errorf("unsupported config version: %d (only version 1 is supported)", config.Version)
	}

	if len(config.Tests) == 0 {
		return fmt.Errorf("at least one test case is required")
	}

	// Validate timeout format
	if config.Settings.Timeout != "" {
		if _, err := time.ParseDuration(config.Settings.Timeout); err != nil {
			return fmt.Errorf("invalid timeout format %q: %w", config.Settings.Timeout, err)
		}
	}

	for i, tc := range config.Tests {
		if tc.Name == "" {
			return fmt.Errorf("test case %d: name is required", i+1)
		}

		// Validate steps
		for j, step := range tc.Steps {
			if step.Block == "" {
				return fmt.Errorf("test %q step %d: block is required", tc.Name, j+1)
			}

			// Validate expected status
			switch step.Expect {
			case StatusSuccess, StatusFail, StatusWarn, StatusBlocked, StatusSkip, StatusConfigError:
				// Valid
			default:
				return fmt.Errorf("test %q step %d: invalid expect value %q", tc.Name, j+1, step.Expect)
			}
		}

		// Validate assertions
		for j, assertion := range tc.Assertions {
			if err := validateAssertion(tc.Name, j, assertion); err != nil {
				return err
			}
		}

		// Validate per-step assertions
		for _, step := range tc.Steps {
			for j, assertion := range step.Assertions {
				if err := validateAssertion(tc.Name, j, assertion); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

// validateAssertion validates a single assertion.
func validateAssertion(testName string, index int, assertion TestAssertion) error {
	switch assertion.Type {
	case AssertionFileExists, AssertionFileNotExists, AssertionDirExists, AssertionDirNotExists:
		if assertion.Path == "" {
			return fmt.Errorf("test %q assertion %d: path is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionFileContains, AssertionFileNotContains:
		if assertion.Path == "" {
			return fmt.Errorf("test %q assertion %d: path is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Contains == "" {
			return fmt.Errorf("test %q assertion %d: contains is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionFileMatches:
		if assertion.Path == "" {
			return fmt.Errorf("test %q assertion %d: path is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Pattern == "" {
			return fmt.Errorf("test %q assertion %d: pattern is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionFileEquals:
		if assertion.Path == "" {
			return fmt.Errorf("test %q assertion %d: path is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Value == "" {
			return fmt.Errorf("test %q assertion %d: value is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionOutputEquals:
		if assertion.Block == "" {
			return fmt.Errorf("test %q assertion %d: block is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Output == "" {
			return fmt.Errorf("test %q assertion %d: output is required for %s", testName, index+1, assertion.Type)
		}
		// value can be empty string, so we don't validate it

	case AssertionOutputMatches:
		if assertion.Block == "" {
			return fmt.Errorf("test %q assertion %d: block is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Output == "" {
			return fmt.Errorf("test %q assertion %d: output is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Pattern == "" {
			return fmt.Errorf("test %q assertion %d: pattern is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionOutputExists:
		if assertion.Block == "" {
			return fmt.Errorf("test %q assertion %d: block is required for %s", testName, index+1, assertion.Type)
		}
		if assertion.Output == "" {
			return fmt.Errorf("test %q assertion %d: output is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionFilesGenerated:
		if assertion.Block == "" {
			return fmt.Errorf("test %q assertion %d: block is required for %s", testName, index+1, assertion.Type)
		}

	case AssertionScript:
		if assertion.Command == "" {
			return fmt.Errorf("test %q assertion %d: command is required for %s", testName, index+1, assertion.Type)
		}

	case "":
		return fmt.Errorf("test %q assertion %d: type is required", testName, index+1)

	default:
		return fmt.Errorf("test %q assertion %d: unknown assertion type %q", testName, index+1, assertion.Type)
	}

	return nil
}

// GetTimeout returns the timeout duration from settings.
func (s *TestSettings) GetTimeout() time.Duration {
	d, err := time.ParseDuration(s.Timeout)
	if err != nil {
		return 5 * time.Minute // Default
	}
	return d
}

// IsParallelizable returns whether this runbook can be tested in parallel with others.
func (s *TestSettings) IsParallelizable() bool {
	if s.Parallelizable == nil {
		return true // Default to true
	}
	return *s.Parallelizable
}

// GetWorkingDir returns the configured working directory, or empty string if temp dir should be used.
func (s *TestSettings) GetWorkingDir() string {
	return s.WorkingDir
}
