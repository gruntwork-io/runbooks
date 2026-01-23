package testing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseConfig_BasicConfig(t *testing.T) {
	yaml := `
version: 1

settings:
  timeout: 10m
  parallelizable: false

tests:
  - name: basic-test
    description: A basic test
    inputs:
      project.Name: "test"
    steps:
      - block: check-git
        expect: success
    assertions:
      - type: file_exists
        path: generated/README.md
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	assert.Equal(t, 1, config.Version)
	assert.Equal(t, "10m", config.Settings.Timeout)
	assert.False(t, *config.Settings.Parallelizable)
	require.Len(t, config.Tests, 1)

	tc := config.Tests[0]
	assert.Equal(t, "basic-test", tc.Name)
	assert.Equal(t, "A basic test", tc.Description)
	assert.True(t, tc.Inputs["project.Name"].IsLiteral())
	assert.Equal(t, "test", tc.Inputs["project.Name"].Literal)

	require.Len(t, tc.Steps, 1)
	assert.Equal(t, "check-git", tc.Steps[0].Block)
	assert.Equal(t, StatusSuccess, tc.Steps[0].Expect)

	require.Len(t, tc.Assertions, 1)
	assert.Equal(t, AssertionFileExists, tc.Assertions[0].Type)
	assert.Equal(t, "generated/README.md", tc.Assertions[0].Path)
}

func TestParseConfig_Defaults(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: minimal-test
    steps:
      - block: my-block
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	// Check defaults
	assert.Equal(t, "5m", config.Settings.Timeout)
	assert.True(t, config.Settings.IsParallelizable())
	assert.Equal(t, StatusSuccess, config.Tests[0].Steps[0].Expect)
}

func TestParseConfig_AllExpectedStatuses(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: status-test
    steps:
      - block: block1
        expect: success
      - block: block2
        expect: fail
      - block: block3
        expect: warn
      - block: block4
        expect: blocked
      - block: block5
        expect: skip
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	assert.Equal(t, StatusSuccess, config.Tests[0].Steps[0].Expect)
	assert.Equal(t, StatusFail, config.Tests[0].Steps[1].Expect)
	assert.Equal(t, StatusWarn, config.Tests[0].Steps[2].Expect)
	assert.Equal(t, StatusBlocked, config.Tests[0].Steps[3].Expect)
	assert.Equal(t, StatusSkip, config.Tests[0].Steps[4].Expect)
}

func TestParseConfig_AllAssertionTypes(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: assertion-test
    assertions:
      - type: file_exists
        path: file.txt
      - type: file_not_exists
        path: missing.txt
      - type: file_contains
        path: file.txt
        contains: "hello"
      - type: file_not_contains
        path: file.txt
        contains: "goodbye"
      - type: file_matches
        path: file.txt
        pattern: "^hello.*"
      - type: file_equals
        path: file.txt
        value: "exact content"
      - type: output_equals
        block: my-block
        output: result
        value: "expected"
      - type: output_matches
        block: my-block
        output: result
        pattern: "^expected.*"
      - type: output_exists
        block: my-block
        output: result
      - type: files_generated
        block: my-template
        min_count: 1
      - type: script
        command: "test -f output.txt"
      - type: dir_exists
        path: generated/
      - type: dir_not_exists
        path: temp/
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)
	require.Len(t, config.Tests[0].Assertions, 13)

	a := config.Tests[0].Assertions
	assert.Equal(t, AssertionFileExists, a[0].Type)
	assert.Equal(t, AssertionFileNotExists, a[1].Type)
	assert.Equal(t, AssertionFileContains, a[2].Type)
	assert.Equal(t, AssertionFileNotContains, a[3].Type)
	assert.Equal(t, AssertionFileMatches, a[4].Type)
	assert.Equal(t, AssertionFileEquals, a[5].Type)
	assert.Equal(t, AssertionOutputEquals, a[6].Type)
	assert.Equal(t, AssertionOutputMatches, a[7].Type)
	assert.Equal(t, AssertionOutputExists, a[8].Type)
	assert.Equal(t, AssertionFilesGenerated, a[9].Type)
	assert.Equal(t, AssertionScript, a[10].Type)
	assert.Equal(t, AssertionDirExists, a[11].Type)
	assert.Equal(t, AssertionDirNotExists, a[12].Type)
}

func TestParseConfig_PerStepAssertions(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: step-assertions
    steps:
      - block: create-resource
        expect: success
        assertions:
          - type: output_exists
            block: create-resource
            output: resource_id
    assertions:
      - type: file_exists
        path: result.txt
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	require.Len(t, config.Tests[0].Steps[0].Assertions, 1)
	assert.Equal(t, AssertionOutputExists, config.Tests[0].Steps[0].Assertions[0].Type)
	require.Len(t, config.Tests[0].Assertions, 1)
}

func TestParseConfig_FuzzInputs(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: fuzz-test
    inputs:
      project.Name:
        fuzz:
          type: string
          minLength: 10
          maxLength: 20
      project.Count:
        fuzz:
          type: int
          min: 1
          max: 100
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	// Fuzz inputs are stored as InputValue with Fuzz field
	nameInput := config.Tests[0].Inputs["project.Name"]
	require.NotNil(t, nameInput.Fuzz, "expected project.Name to have fuzz config")
	assert.Equal(t, FuzzString, nameInput.Fuzz.Type)
	assert.Equal(t, 10, nameInput.Fuzz.MinLength)
	assert.Equal(t, 20, nameInput.Fuzz.MaxLength)
}

func TestParseConfig_Cleanup(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: cleanup-test
    cleanup:
      - command: rm -rf /tmp/test
      - path: cleanup/teardown.sh
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	require.Len(t, config.Tests[0].Cleanup, 2)
	assert.Equal(t, "rm -rf /tmp/test", config.Tests[0].Cleanup[0].Command)
	assert.Equal(t, "cleanup/teardown.sh", config.Tests[0].Cleanup[1].Path)
}

func TestParseConfig_MissingOutputsForBlocked(t *testing.T) {
	yaml := `
version: 1
tests:
  - name: blocked-test
    steps:
      - block: create-resources
        expect: blocked
        missing_outputs:
          - _blocks.create_account.outputs.account_id
`

	config, err := ParseConfig([]byte(yaml))
	require.NoError(t, err)

	step := config.Tests[0].Steps[0]
	assert.Equal(t, StatusBlocked, step.Expect)
	require.Len(t, step.MissingOutputs, 1)
	assert.Equal(t, "_blocks.create_account.outputs.account_id", step.MissingOutputs[0])
}

func TestParseConfig_ValidationErrors(t *testing.T) {
	tests := []struct {
		name        string
		yaml        string
		expectedErr string
	}{
		{
			name: "unsupported version",
			yaml: `
version: 2
tests:
  - name: test
`,
			expectedErr: "unsupported config version: 2",
		},
		{
			name: "no tests",
			yaml: `
version: 1
tests: []
`,
			expectedErr: "at least one test case is required",
		},
		{
			name: "missing test name",
			yaml: `
version: 1
tests:
  - steps:
      - block: test
`,
			expectedErr: "test case 1: name is required",
		},
		{
			name: "missing block in step",
			yaml: `
version: 1
tests:
  - name: test
    steps:
      - expect: success
`,
			expectedErr: `test "test" step 1: block is required`,
		},
		{
			name: "invalid expect status",
			yaml: `
version: 1
tests:
  - name: test
    steps:
      - block: foo
        expect: invalid
`,
			expectedErr: `test "test" step 1: invalid expect value "invalid"`,
		},
		{
			name: "file_exists without path",
			yaml: `
version: 1
tests:
  - name: test
    assertions:
      - type: file_exists
`,
			expectedErr: `test "test" assertion 1: path is required`,
		},
		{
			name: "file_contains without contains",
			yaml: `
version: 1
tests:
  - name: test
    assertions:
      - type: file_contains
        path: file.txt
`,
			expectedErr: `test "test" assertion 1: contains is required`,
		},
		{
			name: "output_equals without block",
			yaml: `
version: 1
tests:
  - name: test
    assertions:
      - type: output_equals
        output: result
        value: test
`,
			expectedErr: `test "test" assertion 1: block is required`,
		},
		{
			name: "invalid timeout",
			yaml: `
version: 1
settings:
  timeout: invalid
tests:
  - name: test
`,
			expectedErr: `invalid timeout format "invalid"`,
		},
		{
			name: "unknown assertion type",
			yaml: `
version: 1
tests:
  - name: test
    assertions:
      - type: unknown_type
        path: file.txt
`,
			expectedErr: `test "test" assertion 1: unknown assertion type "unknown_type"`,
		},
		{
			name: "missing assertion type",
			yaml: `
version: 1
tests:
  - name: test
    assertions:
      - path: file.txt
`,
			expectedErr: `test "test" assertion 1: type is required`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tc.yaml))
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.expectedErr)
		})
	}
}

func TestGetTimeout(t *testing.T) {
	tests := []struct {
		timeout  string
		expected string
	}{
		{"5m", "5m0s"},
		{"10s", "10s"},
		{"1h", "1h0m0s"},
		{"", "5m0s"}, // default
		{"invalid", "5m0s"}, // falls back to default
	}

	for _, tc := range tests {
		t.Run(tc.timeout, func(t *testing.T) {
			s := TestSettings{Timeout: tc.timeout}
			assert.Equal(t, tc.expected, s.GetTimeout().String())
		})
	}
}

func TestIsParallelizable(t *testing.T) {
	t.Run("default is true", func(t *testing.T) {
		s := TestSettings{}
		assert.True(t, s.IsParallelizable())
	})

	t.Run("explicit true", func(t *testing.T) {
		val := true
		s := TestSettings{Parallelizable: &val}
		assert.True(t, s.IsParallelizable())
	})

	t.Run("explicit false", func(t *testing.T) {
		val := false
		s := TestSettings{Parallelizable: &val}
		assert.False(t, s.IsParallelizable())
	})
}
