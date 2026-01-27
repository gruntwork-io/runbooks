package testing

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Reporter defines the interface for test result reporters.
type Reporter interface {
	// Report outputs the test results.
	Report(suites []RunbookTestSuite) error
}

// TextReporter outputs human-readable test results.
type TextReporter struct {
	Writer  io.Writer
	Verbose bool
}

// NewTextReporter creates a new text reporter.
func NewTextReporter(w io.Writer, verbose bool) *TextReporter {
	if w == nil {
		w = os.Stdout
	}
	return &TextReporter{Writer: w, Verbose: verbose}
}

// Report outputs the test results in human-readable format.
func (r *TextReporter) Report(suites []RunbookTestSuite) error {
	var totalPassed, totalFailed, totalSkipped int
	var totalDuration time.Duration

	for _, suite := range suites {
		relPath, _ := filepath.Rel(".", suite.RunbookPath)
		if relPath == "" {
			relPath = suite.RunbookPath
		}

		// In verbose mode, the runbook header was already shown at the start
		// Show a summary section header instead
		if r.Verbose {
			fmt.Fprintf(r.Writer, "\n── Summary: %s ──\n", relPath)
		} else {
			fmt.Fprintf(r.Writer, "\n=== %s ===\n", relPath)
		}

		for _, result := range suite.Results {
			statusIcon := "✓"
			statusColor := "\033[32m" // Green
			if result.Status == TestFailed {
				statusIcon = "✗"
				statusColor = "\033[31m" // Red
			} else if result.Status == TestSkipped {
				statusIcon = "○"
				statusColor = "\033[33m" // Yellow
			}
			resetColor := "\033[0m"

			fmt.Fprintf(r.Writer, "  %s%s%s %s (%s)\n",
				statusColor, statusIcon, resetColor,
				result.TestCase,
				result.Duration.Round(time.Millisecond))

			if result.Error != "" {
				fmt.Fprintf(r.Writer, "    %sError: %s%s\n", statusColor, result.Error, resetColor)
			}

			if r.Verbose {
				// In verbose mode, detailed logs were already shown during execution.
				// Here we show a condensed summary of each step.
				for _, step := range result.StepResults {
					stepIcon := "✓"
					stepColor := "\033[32m"
					if !step.Passed {
						stepIcon = "✗"
						stepColor = "\033[31m"
					}

					// Show step with output count if any
					outputInfo := ""
					if len(step.Outputs) > 0 {
						outputInfo = fmt.Sprintf(" [%d output(s)]", len(step.Outputs))
					}

					fmt.Fprintf(r.Writer, "    %s%s%s %s: %s%s (%s)\n",
						stepColor, stepIcon, resetColor,
						step.Block, step.ActualStatus, outputInfo,
						step.Duration.Round(time.Millisecond))

				// Show step error if: has error, not already displayed in verbose block, and not same as result error
				if step.Error != "" && !step.ErrorDisplayed && step.Error != result.Error {
					fmt.Fprintf(r.Writer, "      Error: %s\n", step.Error)
				}
				}

				for _, ar := range result.Assertions {
					arIcon := "✓"
					arColor := "\033[32m"
					if !ar.Passed {
						arIcon = "✗"
						arColor = "\033[31m"
					}
					fmt.Fprintf(r.Writer, "    %s%s%s Assertion %s\n",
						arColor, arIcon, resetColor, ar.Type)
					if ar.Message != "" {
						fmt.Fprintf(r.Writer, "      %s\n", ar.Message)
					}
				}
			}
		}

		totalPassed += suite.Passed
		totalFailed += suite.Failed
		totalSkipped += suite.Skipped
		totalDuration += suite.Duration
	}

	// Summary
	fmt.Fprintln(r.Writer)
	summaryColor := "\033[32m" // Green
	if totalFailed > 0 {
		summaryColor = "\033[31m" // Red
	}
	resetColor := "\033[0m"

	fmt.Fprintf(r.Writer, "%sResults: %d passed, %d failed, %d skipped%s (total: %s)\n",
		summaryColor, totalPassed, totalFailed, totalSkipped, resetColor,
		totalDuration.Round(time.Millisecond))

	return nil
}

// JUnitReporter outputs JUnit XML format for CI integration.
type JUnitReporter struct {
	Writer io.Writer
}

// JUnitTestSuites is the root element of JUnit XML.
type JUnitTestSuites struct {
	XMLName    xml.Name         `xml:"testsuites"`
	Tests      int              `xml:"tests,attr"`
	Failures   int              `xml:"failures,attr"`
	Skipped    int              `xml:"skipped,attr"`
	Time       float64          `xml:"time,attr"`
	TestSuites []JUnitTestSuite `xml:"testsuite"`
}

// JUnitTestSuite represents a test suite in JUnit XML.
type JUnitTestSuite struct {
	XMLName   xml.Name        `xml:"testsuite"`
	Name      string          `xml:"name,attr"`
	Tests     int             `xml:"tests,attr"`
	Failures  int             `xml:"failures,attr"`
	Skipped   int             `xml:"skipped,attr"`
	Time      float64         `xml:"time,attr"`
	TestCases []JUnitTestCase `xml:"testcase"`
}

// JUnitTestCase represents a test case in JUnit XML.
type JUnitTestCase struct {
	XMLName   xml.Name       `xml:"testcase"`
	Name      string         `xml:"name,attr"`
	ClassName string         `xml:"classname,attr"`
	Time      float64        `xml:"time,attr"`
	Failure   *JUnitFailure  `xml:"failure,omitempty"`
	Skipped   *JUnitSkipped  `xml:"skipped,omitempty"`
}

// JUnitFailure represents a failure in JUnit XML.
type JUnitFailure struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Content string `xml:",chardata"`
}

// JUnitSkipped represents a skipped test in JUnit XML.
type JUnitSkipped struct {
	Message string `xml:"message,attr,omitempty"`
}

// NewJUnitReporter creates a new JUnit reporter.
func NewJUnitReporter(w io.Writer) *JUnitReporter {
	if w == nil {
		w = os.Stdout
	}
	return &JUnitReporter{Writer: w}
}

// Report outputs the test results in JUnit XML format.
func (r *JUnitReporter) Report(suites []RunbookTestSuite) error {
	junitSuites := JUnitTestSuites{}

	for _, suite := range suites {
		js := JUnitTestSuite{
			Name:     suite.RunbookPath,
			Tests:    len(suite.Results),
			Failures: suite.Failed,
			Skipped:  suite.Skipped,
			Time:     suite.Duration.Seconds(),
		}

		for _, result := range suite.Results {
			tc := JUnitTestCase{
				Name:      result.TestCase,
				ClassName: filepath.Base(filepath.Dir(suite.RunbookPath)),
				Time:      result.Duration.Seconds(),
			}

			if result.Status == TestFailed {
				// Build failure details
				var details []string
				if result.Error != "" {
					details = append(details, result.Error)
				}
				for _, step := range result.StepResults {
					if !step.Passed {
						details = append(details, fmt.Sprintf("Block %s: %s", step.Block, step.Error))
					}
				}
				for _, ar := range result.Assertions {
					if !ar.Passed {
						details = append(details, fmt.Sprintf("Assertion %s: %s", ar.Type, ar.Message))
					}
				}

				tc.Failure = &JUnitFailure{
					Message: result.Error,
					Type:    "TestFailure",
					Content: strings.Join(details, "\n"),
				}
			} else if result.Status == TestSkipped {
				tc.Skipped = &JUnitSkipped{}
			}

			js.TestCases = append(js.TestCases, tc)
		}

		junitSuites.TestSuites = append(junitSuites.TestSuites, js)
		junitSuites.Tests += js.Tests
		junitSuites.Failures += js.Failures
		junitSuites.Skipped += js.Skipped
		junitSuites.Time += js.Time
	}

	// Write XML
	fmt.Fprintln(r.Writer, `<?xml version="1.0" encoding="UTF-8"?>`)
	enc := xml.NewEncoder(r.Writer)
	enc.Indent("", "  ")
	return enc.Encode(junitSuites)
}

// ReportToFile writes test results to a file.
func ReportToFile(reporter Reporter, suites []RunbookTestSuite, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("failed to create output file: %w", err)
	}
	defer f.Close()

	// Update reporter's writer
	switch r := reporter.(type) {
	case *TextReporter:
		r.Writer = f
	case *JUnitReporter:
		r.Writer = f
	}

	return reporter.Report(suites)
}
