package testing

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"runbooks/api"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseAuthDependencies(t *testing.T) {
	tests := []struct {
		name         string
		content      string
		expectedDeps map[string]AuthDependency
	}{
		{
			name: "no auth dependencies",
			content: `
# Simple Runbook

<Command id="simple-cmd" command="echo hello" />
<Check id="simple-check" command="test -f file.txt" />
`,
			expectedDeps: map[string]AuthDependency{},
		},
		{
			name: "single AWS auth dependency",
			content: `
<AwsAuth id="aws-creds" />
<Command id="deploy" awsAuthId="aws-creds" command="aws s3 ls" />
`,
			expectedDeps: map[string]AuthDependency{
				"deploy": {
					BlockID:       "deploy",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "single GitHub auth dependency",
			content: `
<GitHubAuth id="gh-auth" />
<Command id="clone-repo" githubAuthId="gh-auth" command="git clone repo" />
`,
			expectedDeps: map[string]AuthDependency{
				"clone-repo": {
					BlockID:       "clone-repo",
					AuthBlockID:   "gh-auth",
					AuthBlockType: BlockTypeGitHubAuth,
				},
			},
		},
		{
			name: "Check block with auth dependency",
			content: `
<AwsAuth id="aws-creds" />
<Check id="verify-bucket" awsAuthId="aws-creds" command="aws s3 ls s3://bucket" />
`,
			expectedDeps: map[string]AuthDependency{
				"verify-bucket": {
					BlockID:       "verify-bucket",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "multiple auth dependencies",
			content: `
<AwsAuth id="aws-creds" />
<GitHubAuth id="gh-auth" />
<Command id="deploy" awsAuthId="aws-creds" command="aws deploy" />
<Command id="clone" githubAuthId="gh-auth" command="git clone" />
<Check id="verify" awsAuthId="aws-creds" command="aws verify" />
`,
			expectedDeps: map[string]AuthDependency{
				"deploy": {
					BlockID:       "deploy",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
				"clone": {
					BlockID:       "clone",
					AuthBlockID:   "gh-auth",
					AuthBlockType: BlockTypeGitHubAuth,
				},
				"verify": {
					BlockID:       "verify",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "mixed blocks with and without auth",
			content: `
<AwsAuth id="aws-creds" />
<Command id="no-auth" command="echo hello" />
<Command id="with-auth" awsAuthId="aws-creds" command="aws s3 ls" />
<Check id="local-check" command="test -f file.txt" />
`,
			expectedDeps: map[string]AuthDependency{
				"with-auth": {
					BlockID:       "with-auth",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		// =======================================================================
		// Fenced code block tests - these verify components in documentation
		// examples are NOT parsed as real auth dependencies
		// =======================================================================
		{
			name: "skip auth dependencies inside fenced code blocks",
			content: `
# Real runbook content

<AwsAuth id="real-auth" />
<Command id="real-cmd" awsAuthId="real-auth" command="aws s3 ls" />

## Documentation example

Here's how to use auth:

` + "```mdx" + `
<AwsAuth id="example-auth" />
<Command id="example-cmd" awsAuthId="example-auth" command="aws s3 ls" />
` + "```" + `

More content after the code block.
`,
			expectedDeps: map[string]AuthDependency{
				"real-cmd": {
					BlockID:       "real-cmd",
					AuthBlockID:   "real-auth",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "skip GitHub auth inside fenced code blocks",
			content: `
<GitHubAuth id="real-gh" />
<Command id="real-clone" githubAuthId="real-gh" command="git clone" />

Example in docs:

` + "```" + `
<GitHubAuth id="fake-gh" />
<Command id="fake-clone" githubAuthId="fake-gh" command="git clone example" />
` + "```" + `
`,
			expectedDeps: map[string]AuthDependency{
				"real-clone": {
					BlockID:       "real-clone",
					AuthBlockID:   "real-gh",
					AuthBlockType: BlockTypeGitHubAuth,
				},
			},
		},
		{
			name: "skip multiple components in fenced code blocks",
			content: `
<Command id="before" awsAuthId="auth1" command="before" />

` + "```mdx" + `
{/* Example 1 */}
<Command id="example-1" awsAuthId="auth-a" command="a" />

{/* Example 2 */}
<Check id="example-2" githubAuthId="auth-b" command="b" />

{/* Example 3 */}
<Command id="example-3" awsAuthId="auth-c" command="c" />
` + "```" + `

<Command id="after" githubAuthId="auth2" command="after" />
`,
			expectedDeps: map[string]AuthDependency{
				"before": {
					BlockID:       "before",
					AuthBlockID:   "auth1",
					AuthBlockType: BlockTypeAwsAuth,
				},
				"after": {
					BlockID:       "after",
					AuthBlockID:   "auth2",
					AuthBlockType: BlockTypeGitHubAuth,
				},
			},
		},
		{
			name: "handle multiple code blocks interspersed with real content",
			content: `
<AwsAuth id="aws" />
<Command id="cmd1" awsAuthId="aws" command="cmd1" />

` + "```bash" + `
# Not a component, just bash
aws s3 ls
` + "```" + `

` + "```mdx" + `
<Command id="fake1" awsAuthId="fake" command="fake" />
` + "```" + `

<Check id="check1" awsAuthId="aws" command="check1" />

` + "```" + `
<Check id="fake2" githubAuthId="fake" command="fake" />
` + "```" + `

<Command id="cmd2" awsAuthId="aws" command="cmd2" />
`,
			expectedDeps: map[string]AuthDependency{
				"cmd1": {
					BlockID:       "cmd1",
					AuthBlockID:   "aws",
					AuthBlockType: BlockTypeAwsAuth,
				},
				"check1": {
					BlockID:       "check1",
					AuthBlockID:   "aws",
					AuthBlockType: BlockTypeAwsAuth,
				},
				"cmd2": {
					BlockID:       "cmd2",
					AuthBlockID:   "aws",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "code block at start of file",
			content: "```mdx\n<Command id=\"fake\" awsAuthId=\"fake\" command=\"fake\" />\n```\n\n<Command id=\"real\" awsAuthId=\"real\" command=\"real\" />",
			expectedDeps: map[string]AuthDependency{
				"real": {
					BlockID:       "real",
					AuthBlockID:   "real",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "code block at end of file",
			content: "<Command id=\"real\" awsAuthId=\"real\" command=\"real\" />\n\n```mdx\n<Command id=\"fake\" awsAuthId=\"fake\" command=\"fake\" />\n```",
			expectedDeps: map[string]AuthDependency{
				"real": {
					BlockID:       "real",
					AuthBlockID:   "real",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "nested-looking content in code blocks",
			content: `
<Command id="outer" awsAuthId="outer-auth" command="outer" />

` + "```mdx" + `
Here's an example with nested code:

<Command id="inner" awsAuthId="inner-auth" command="inner" />
` + "```" + `
`,
			expectedDeps: map[string]AuthDependency{
				"outer": {
					BlockID:       "outer",
					AuthBlockID:   "outer-auth",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Create a temporary file with the test content
			tmpDir := t.TempDir()
			runbookPath := filepath.Join(tmpDir, "runbook.mdx")
			err := os.WriteFile(runbookPath, []byte(tc.content), 0644)
			require.NoError(t, err)

			// Parse auth dependencies
			deps, err := parseAuthDependencies(runbookPath)
			require.NoError(t, err)

			// Verify the results
			assert.Equal(t, len(tc.expectedDeps), len(deps),
				"expected %d dependencies, got %d", len(tc.expectedDeps), len(deps))

			for blockID, expected := range tc.expectedDeps {
				actual, ok := deps[blockID]
				assert.True(t, ok, "expected dependency for block %q not found", blockID)
				if ok {
					assert.Equal(t, expected.BlockID, actual.BlockID, "BlockID mismatch for %q", blockID)
					assert.Equal(t, expected.AuthBlockID, actual.AuthBlockID, "AuthBlockID mismatch for %q", blockID)
					assert.Equal(t, expected.AuthBlockType, actual.AuthBlockType, "AuthBlockType mismatch for %q", blockID)
				}
			}

			// Also verify no unexpected dependencies
			for blockID := range deps {
				_, expected := tc.expectedDeps[blockID]
				assert.True(t, expected, "unexpected dependency found for block %q", blockID)
			}
		})
	}
}

func TestParseAuthDependencies_FileNotFound(t *testing.T) {
	_, err := parseAuthDependencies("/nonexistent/path/runbook.mdx")
	require.Error(t, err)
}

func TestReadAwsEnvCredentials(t *testing.T) {
	tests := []struct {
		name          string
		prefix        string
		envVars       map[string]string
		expectedFound bool
		expectedCreds api.AwsEnvCredentials
		expectError   bool
	}{
		{
			name:   "standard env vars found",
			prefix: "",
			envVars: map[string]string{
				"AWS_ACCESS_KEY_ID":     "AKIAIOSFODNN7EXAMPLE",
				"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				"AWS_REGION":            "us-west-2",
			},
			expectedFound: true,
			expectedCreds: api.AwsEnvCredentials{
				AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
				SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				Region:          "us-west-2",
			},
		},
		{
			name:   "prefixed env vars found",
			prefix: "CI_",
			envVars: map[string]string{
				"CI_AWS_ACCESS_KEY_ID":     "AKIAIOSFODNN7EXAMPLE",
				"CI_AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				"CI_AWS_SESSION_TOKEN":     "session-token",
				"CI_AWS_REGION":            "eu-west-1",
			},
			expectedFound: true,
			expectedCreds: api.AwsEnvCredentials{
				AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
				SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				SessionToken:    "session-token",
				Region:          "eu-west-1",
			},
		},
		{
			name:          "no credentials found",
			prefix:        "",
			envVars:       map[string]string{},
			expectedFound: false,
			expectedCreds: api.AwsEnvCredentials{},
		},
		{
			name:   "only access key found (incomplete)",
			prefix: "",
			envVars: map[string]string{
				"AWS_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
			},
			expectedFound: false,
			expectedCreds: api.AwsEnvCredentials{
				AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
			},
		},
		{
			name:        "invalid prefix",
			prefix:      "invalid-prefix",
			envVars:     map[string]string{},
			expectError: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Use a custom getenv that only sees the test's env vars, so real
			// credentials from the developer's shell don't leak through.
			getenv := func(key string) string {
				return tc.envVars[key]
			}

			creds, found, err := api.ReadAwsEnvCredentials(tc.prefix, getenv)

			if tc.expectError {
				assert.Error(t, err)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.expectedFound, found)
			assert.Equal(t, tc.expectedCreds.AccessKeyID, creds.AccessKeyID)
			assert.Equal(t, tc.expectedCreds.SecretAccessKey, creds.SecretAccessKey)
			assert.Equal(t, tc.expectedCreds.SessionToken, creds.SessionToken)
			assert.Equal(t, tc.expectedCreds.Region, creds.Region)
		})
	}
}

// TestAuthBlockCredentialIsolation verifies that when a Check/Command block specifies
// awsAuthId or githubAuthId, it receives credentials from that specific auth block,
// not from the session (which may have been overwritten by another auth block).
func TestAuthBlockCredentialIsolation(t *testing.T) {
	// Create temporary directory for test files
	tmpDir, err := os.MkdirTemp("", "credential-isolation-test")
	require.NoError(t, err)
	defer os.RemoveAll(tmpDir)

	// Create runbook with two AwsAuth blocks
	// Each Check block specifies which auth block's credentials to use via awsAuthId
	// The env_prefix for each auth block is configured in the test config, not the MDX
	runbookContent := `# Multi-Account Credential Isolation Test

<AwsAuth
  id="aws-auth-primary"
  detectCredentials={['env']}
/>

<AwsAuth
  id="aws-auth-secondary"
  detectCredentials={['env']}
/>

## Check blocks referencing specific auth blocks

<Check
  id="check-primary"
  awsAuthId="aws-auth-primary"
  command="echo ACCESS_KEY=$AWS_ACCESS_KEY_ID"
/>

<Check
  id="check-secondary"
  awsAuthId="aws-auth-secondary"
  command="echo ACCESS_KEY=$AWS_ACCESS_KEY_ID"
/>

## Check block without awsAuthId (uses session credentials)

<Check
  id="check-session"
  command="echo ACCESS_KEY=$AWS_ACCESS_KEY_ID"
/>
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	err = os.WriteFile(runbookPath, []byte(runbookContent), 0644)
	require.NoError(t, err)

	// Create test config that runs both auth blocks and both check blocks
	// env_prefix on each auth step tells the executor which prefixed env vars to use
	testConfig := `version: 1
tests:
  - name: credential-isolation
    steps:
      - block: aws-auth-primary
        env_prefix: PRIMARY_
        expect: success
      - block: aws-auth-secondary
        env_prefix: SECONDARY_
        expect: success
      - block: check-primary
        expect: success
      - block: check-secondary
        expect: success
      - block: check-session
        expect: success
`
	configPath := filepath.Join(tmpDir, "runbook_test.yml")
	err = os.WriteFile(configPath, []byte(testConfig), 0644)
	require.NoError(t, err)

	// Set up credentials for each auth block
	// PRIMARY_ credentials
	t.Setenv("PRIMARY_AWS_ACCESS_KEY_ID", "AKIAPRIMARY123456789")
	t.Setenv("PRIMARY_AWS_SECRET_ACCESS_KEY", "primary-secret-key")
	t.Setenv("PRIMARY_AWS_REGION", "us-west-2")

	// SECONDARY_ credentials (different from PRIMARY)
	t.Setenv("SECONDARY_AWS_ACCESS_KEY_ID", "AKIASECONDARY987654")
	t.Setenv("SECONDARY_AWS_SECRET_ACCESS_KEY", "secondary-secret-key")
	t.Setenv("SECONDARY_AWS_REGION", "eu-west-1")

	// Create executor
	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated", WithVerbose(true))
	require.NoError(t, err)

	// Parse config
	config, err := LoadConfig(configPath)
	require.NoError(t, err)

	// Run the test
	testResult := executor.RunTest(config.Tests[0])

	// Verify all steps passed
	for _, step := range testResult.StepResults {
		assert.True(t, step.Passed, "Step %s should pass: %s", step.Block, step.Error)
	}

	// Find and verify check-primary got PRIMARY credentials
	var checkPrimaryLogs string
	var checkSecondaryLogs string
	var checkSessionLogs string

	for _, step := range testResult.StepResults {
		switch step.Block {
		case "check:check-primary":
			checkPrimaryLogs = step.Logs
		case "check:check-secondary":
			checkSecondaryLogs = step.Logs
		case "check:check-session":
			checkSessionLogs = step.Logs
		}
	}

	// check-primary should have received PRIMARY credentials (via awsAuthId)
	assert.Contains(t, checkPrimaryLogs, "ACCESS_KEY=AKIAPRIMARY123456789",
		"check-primary should receive credentials from aws-auth-primary")

	// check-secondary should have received SECONDARY credentials (via awsAuthId)
	assert.Contains(t, checkSecondaryLogs, "ACCESS_KEY=AKIASECONDARY987654",
		"check-secondary should receive credentials from aws-auth-secondary")

	// check-session (without awsAuthId) should have SECONDARY credentials
	// because aws-auth-secondary was the last to run and overwrote the session
	assert.Contains(t, checkSessionLogs, "ACCESS_KEY=AKIASECONDARY987654",
		"check-session should receive session credentials (last auth block executed)")
}

// =============================================================================
// GitClone block tests
// =============================================================================

// TestParseAuthDependencies_GitClone verifies that GitClone blocks are recognized
// as auth-dependent block types (added to authBlockDependentTypes on this branch).
func TestParseAuthDependencies_GitClone(t *testing.T) {
	tests := []struct {
		name         string
		content      string
		expectedDeps map[string]AuthDependency
	}{
		{
			name: "GitClone with githubAuthId",
			content: `
<GitHubAuth id="gh-auth" />
<GitClone id="clone-repo" githubAuthId="gh-auth" prefilledUrl="https://github.com/org/repo" />
`,
			expectedDeps: map[string]AuthDependency{
				"clone-repo": {
					BlockID:       "clone-repo",
					AuthBlockID:   "gh-auth",
					AuthBlockType: BlockTypeGitHubAuth,
				},
			},
		},
		{
			name: "GitClone with awsAuthId",
			content: `
<AwsAuth id="aws-creds" />
<GitClone id="clone-cc" awsAuthId="aws-creds" prefilledUrl="https://git-codecommit.us-east-1.amazonaws.com/v1/repos/myrepo" />
`,
			expectedDeps: map[string]AuthDependency{
				"clone-cc": {
					BlockID:       "clone-cc",
					AuthBlockID:   "aws-creds",
					AuthBlockType: BlockTypeAwsAuth,
				},
			},
		},
		{
			name: "GitClone without auth dependency",
			content: `
<GitClone id="clone-public" prefilledUrl="https://github.com/org/public-repo" />
`,
			expectedDeps: map[string]AuthDependency{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			runbookPath := filepath.Join(tmpDir, "runbook.mdx")
			err := os.WriteFile(runbookPath, []byte(tc.content), 0644)
			require.NoError(t, err)

			deps, err := parseAuthDependencies(runbookPath)
			require.NoError(t, err)

			assert.Equal(t, len(tc.expectedDeps), len(deps))
			for blockID, expected := range tc.expectedDeps {
				actual, ok := deps[blockID]
				assert.True(t, ok, "expected dependency for block %q not found", blockID)
				if ok {
					assert.Equal(t, expected.BlockID, actual.BlockID)
					assert.Equal(t, expected.AuthBlockID, actual.AuthBlockID)
					assert.Equal(t, expected.AuthBlockType, actual.AuthBlockType)
				}
			}
		})
	}
}

// initLocalGitRepo creates a bare git repo with a single commit for testing GitClone.
// Returns the file:// URL to the repo.
func initLocalGitRepo(t *testing.T, files map[string]string) string {
	t.Helper()

	// Create a bare repo
	bareDir := filepath.Join(t.TempDir(), "bare.git")
	runGit(t, "", "init", "--bare", bareDir)

	// Create a working clone, add files, commit, push
	workDir := filepath.Join(t.TempDir(), "work")
	runGit(t, "", "clone", bareDir, workDir)
	runGit(t, workDir, "config", "user.email", "test@test.com")
	runGit(t, workDir, "config", "user.name", "Test")

	for name, content := range files {
		fullPath := filepath.Join(workDir, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(fullPath), 0755))
		require.NoError(t, os.WriteFile(fullPath, []byte(content), 0644))
	}

	runGit(t, workDir, "add", ".")
	runGit(t, workDir, "commit", "-m", "initial")
	runGit(t, workDir, "push", "origin", "HEAD")

	return "file://" + bareDir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v failed: %s", args, string(out))
}

// TestExecuteGitClone_SkipWhenNoURL verifies that a GitClone block without
// a prefilledUrl is skipped (the user would fill it interactively).
func TestExecuteGitClone_SkipWhenNoURL(t *testing.T) {
	tmpDir := t.TempDir()
	runbookContent := `# GitClone Skip Test
<GitClone id="clone-empty" />
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "skip-no-url",
		Steps: []TestStep{
			{Block: "clone-empty", Expect: StatusSkip},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	// Find the clone step result
	var cloneResult *StepResult
	for i := range result.StepResults {
		if result.StepResults[i].Block == "gitClone:clone-empty" {
			cloneResult = &result.StepResults[i]
			break
		}
	}
	require.NotNil(t, cloneResult, "should have a step result for clone-empty")
	assert.True(t, cloneResult.Passed)
	assert.Equal(t, "skipped", cloneResult.ActualStatus)
}

// TestExecuteGitClone_Success clones a real local git repo and verifies
// outputs (CLONE_PATH, FILE_COUNT) and activeWorkTreePath are set.
func TestExecuteGitClone_Success(t *testing.T) {
	repoURL := initLocalGitRepo(t, map[string]string{
		"README.md":  "# Test Repo",
		"src/main.go": "package main",
	})

	tmpDir := t.TempDir()
	runbookContent := fmt.Sprintf(`# GitClone Success Test
<GitClone id="clone-test" prefilledUrl="%s" />

<Check id="verify-clone" command="test -d $REPO_FILES" />
`, repoURL)
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "clone-success",
		Steps: []TestStep{
			{Block: "clone-test", Expect: StatusSuccess},
			{Block: "verify-clone", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	// Verify GitClone step outputs
	var cloneResult *StepResult
	for i := range result.StepResults {
		if result.StepResults[i].Block == "gitClone:clone-test" {
			cloneResult = &result.StepResults[i]
			break
		}
	}
	require.NotNil(t, cloneResult, "should have a step result for clone-test")
	assert.True(t, cloneResult.Passed)
	assert.Equal(t, "success", cloneResult.ActualStatus)
	assert.NotEmpty(t, cloneResult.Outputs["CLONE_PATH"])
	assert.Equal(t, "2", cloneResult.Outputs["FILE_COUNT"]) // README.md + src/main.go

	// Verify cloned files exist on disk
	clonePath := cloneResult.Outputs["CLONE_PATH"]
	_, err = os.Stat(filepath.Join(clonePath, "README.md"))
	assert.NoError(t, err, "README.md should exist in clone")
	_, err = os.Stat(filepath.Join(clonePath, "src/main.go"))
	assert.NoError(t, err, "src/main.go should exist in clone")

	// Verify activeWorkTreePath was set (Check block can use REPO_FILES)
	assert.Equal(t, clonePath, executor.activeWorkTreePath)
}

// TestExecuteGitClone_WithRef clones a specific branch.
func TestExecuteGitClone_WithRef(t *testing.T) {
	// Create repo with a second branch
	bareDir := filepath.Join(t.TempDir(), "bare.git")
	runGit(t, "", "init", "--bare", bareDir)

	workDir := filepath.Join(t.TempDir(), "work")
	runGit(t, "", "clone", bareDir, workDir)
	runGit(t, workDir, "config", "user.email", "test@test.com")
	runGit(t, workDir, "config", "user.name", "Test")

	require.NoError(t, os.WriteFile(filepath.Join(workDir, "main.txt"), []byte("main"), 0644))
	runGit(t, workDir, "add", ".")
	runGit(t, workDir, "commit", "-m", "main commit")
	runGit(t, workDir, "push", "origin", "HEAD")

	// Create a feature branch with an extra file
	runGit(t, workDir, "checkout", "-b", "feature")
	require.NoError(t, os.WriteFile(filepath.Join(workDir, "feature.txt"), []byte("feature"), 0644))
	runGit(t, workDir, "add", ".")
	runGit(t, workDir, "commit", "-m", "feature commit")
	runGit(t, workDir, "push", "origin", "feature")

	repoURL := "file://" + bareDir

	tmpDir := t.TempDir()
	runbookContent := fmt.Sprintf(`# GitClone Ref Test
<GitClone id="clone-ref" prefilledUrl="%s" prefilledRef="feature" />
`, repoURL)
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "clone-ref",
		Steps: []TestStep{
			{Block: "clone-ref", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	var cloneResult *StepResult
	for i := range result.StepResults {
		if result.StepResults[i].Block == "gitClone:clone-ref" {
			cloneResult = &result.StepResults[i]
			break
		}
	}
	require.NotNil(t, cloneResult)
	assert.True(t, cloneResult.Passed)
	assert.Equal(t, "feature", cloneResult.Outputs["REF"])
	assert.Equal(t, "2", cloneResult.Outputs["FILE_COUNT"]) // main.txt + feature.txt

	// Verify the feature branch file exists
	clonePath := cloneResult.Outputs["CLONE_PATH"]
	_, err = os.Stat(filepath.Join(clonePath, "feature.txt"))
	assert.NoError(t, err, "feature.txt should exist when cloning the feature branch")
}

// TestExecuteGitClone_SparseCheckout clones only a subdirectory.
func TestExecuteGitClone_SparseCheckout(t *testing.T) {
	repoURL := initLocalGitRepo(t, map[string]string{
		"docs/README.md":   "# Docs",
		"docs/guide.md":    "# Guide",
		"src/main.go":      "package main",
		"src/main_test.go": "package main",
	})

	tmpDir := t.TempDir()
	runbookContent := fmt.Sprintf(`# GitClone Sparse Test
<GitClone id="clone-sparse" prefilledUrl="%s" prefilledRepoPath="docs" />
`, repoURL)
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "clone-sparse",
		Steps: []TestStep{
			{Block: "clone-sparse", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	var cloneResult *StepResult
	for i := range result.StepResults {
		if result.StepResults[i].Block == "gitClone:clone-sparse" {
			cloneResult = &result.StepResults[i]
			break
		}
	}
	require.NotNil(t, cloneResult)
	assert.True(t, cloneResult.Passed)

	clonePath := cloneResult.Outputs["CLONE_PATH"]
	// Sparse checkout should have docs/ files
	_, err = os.Stat(filepath.Join(clonePath, "docs/README.md"))
	assert.NoError(t, err, "docs/README.md should exist in sparse checkout")

	// src/ should NOT be checked out
	_, err = os.Stat(filepath.Join(clonePath, "src/main.go"))
	assert.True(t, os.IsNotExist(err), "src/main.go should not exist in sparse checkout")
}

// =============================================================================
// TemplateInline generateFile + target=worktree tests
// =============================================================================

// TestExecuteTemplateInline_GenerateFile verifies that when generateFile={true}
// is set, the rendered template is written to disk under the output directory.
func TestExecuteTemplateInline_GenerateFile(t *testing.T) {
	tmpDir := t.TempDir()
	runbookContent := `# TemplateInline GenerateFile Test

<Inputs id="config">
</Inputs>

<TemplateInline outputPath="output.txt" generateFile={true}>
` + "```" + `
Hello from template
` + "```" + `
</TemplateInline>
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "generate-file",
		Steps: []TestStep{
			{Block: "template-inline-output-txt", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	// Verify the file was written to disk
	outputFile := filepath.Join(tmpDir, "generated", "output.txt")
	content, err := os.ReadFile(outputFile)
	require.NoError(t, err, "output.txt should be written to disk when generateFile=true")
	assert.Contains(t, string(content), "Hello from template")
}

// TestExecuteTemplateInline_WorktreeTarget_NoWorktree verifies that target="worktree"
// fails when no GitClone has been executed.
func TestExecuteTemplateInline_WorktreeTarget_NoWorktree(t *testing.T) {
	tmpDir := t.TempDir()
	runbookContent := `# TemplateInline Worktree Error Test

<TemplateInline outputPath="config.yaml" generateFile={true} target="worktree">
` + "```yaml" + `
key: value
` + "```" + `
</TemplateInline>
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "worktree-no-clone",
		Steps: []TestStep{
			{Block: "template-inline-config-yaml", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestFailed, result.Status)
	assert.Contains(t, result.Error, "worktree")
}

// TestExecuteTemplateInline_WorktreeTarget_WithClone verifies that target="worktree"
// writes files into the cloned repo directory.
func TestExecuteTemplateInline_WorktreeTarget_WithClone(t *testing.T) {
	repoURL := initLocalGitRepo(t, map[string]string{
		"README.md": "# Test",
	})

	tmpDir := t.TempDir()
	runbookContent := fmt.Sprintf(`# TemplateInline Worktree Test

<GitClone id="clone-repo" prefilledUrl="%s" />

<TemplateInline outputPath="generated.txt" generateFile={true} target="worktree">
`+"```"+`
Generated content
`+"```"+`
</TemplateInline>
`, repoURL)
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "worktree-with-clone",
		Steps: []TestStep{
			{Block: "clone-repo", Expect: StatusSuccess},
			{Block: "template-inline-generated-txt", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestPassed, result.Status, "test should pass: %s", result.Error)

	// File should be in the clone directory, not the generated directory
	clonePath := executor.activeWorkTreePath
	require.NotEmpty(t, clonePath)

	content, err := os.ReadFile(filepath.Join(clonePath, "generated.txt"))
	require.NoError(t, err, "generated.txt should be written to worktree")
	assert.Contains(t, string(content), "Generated content")

	// Should NOT exist in the regular generated directory
	_, err = os.Stat(filepath.Join(tmpDir, "generated", "generated.txt"))
	assert.True(t, os.IsNotExist(err), "file should not be in the generated directory when target=worktree")
}

// =============================================================================
// Template target=worktree test
// =============================================================================

// TestExecuteTemplate_WorktreeTarget_NoWorktree verifies that target="worktree"
// fails for Template blocks when no GitClone has been executed.
func TestExecuteTemplate_WorktreeTarget_NoWorktree(t *testing.T) {
	tmpDir := t.TempDir()

	// Create a minimal boilerplate template
	templateDir := filepath.Join(tmpDir, "templates", "my-template")
	require.NoError(t, os.MkdirAll(templateDir, 0755))
	require.NoError(t, os.WriteFile(
		filepath.Join(templateDir, "boilerplate.yml"),
		[]byte("variables: []\n"),
		0644,
	))
	require.NoError(t, os.WriteFile(
		filepath.Join(templateDir, "output.txt"),
		[]byte("template output"),
		0644,
	))

	runbookContent := `# Template Worktree Error Test

<Template id="my-tmpl" path="templates/my-template" target="worktree" />
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	result := executor.RunTest(TestCase{
		Name: "template-worktree-no-clone",
		Steps: []TestStep{
			{Block: "my-tmpl", Expect: StatusSuccess},
		},
	})

	assert.Equal(t, TestFailed, result.Status)
	assert.Contains(t, result.Error, "worktree")
}

// =============================================================================
// extractMDXPropValue bare JSX expression test
// =============================================================================

func TestExtractMDXPropValue_BareJSXExpression(t *testing.T) {
	tests := []struct {
		name     string
		props    string
		propName string
		expected string
	}{
		{
			name:     "bare boolean true",
			props:    `generateFile={true}`,
			propName: "generateFile",
			expected: "true",
		},
		{
			name:     "bare boolean false",
			props:    `generateFile={false}`,
			propName: "generateFile",
			expected: "false",
		},
		{
			name:     "bare number",
			props:    `count={42}`,
			propName: "count",
			expected: "42",
		},
		{
			name:     "mixed with string props",
			props:    `id="my-block" generateFile={true} outputPath="out.txt"`,
			propName: "generateFile",
			expected: "true",
		},
		{
			// Quoted string in JSX should still match the earlier pattern
			name:     "quoted string in JSX still works",
			props:    `target={"worktree"}`,
			propName: "target",
			expected: "worktree",
		},
		{
			name:     "standard double-quoted prop still works",
			props:    `target="generated"`,
			propName: "target",
			expected: "generated",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := extractMDXPropValue(tc.props, tc.propName)
			assert.Equal(t, tc.expected, result)
		})
	}
}

// =============================================================================
// getSessionEnvVar test
// =============================================================================

func TestGetSessionEnvVar(t *testing.T) {
	tmpDir := t.TempDir()
	runbookContent := `# Session Env Test
<Check id="noop" command="true" />
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(runbookContent), 0644))

	executor, err := NewTestExecutor(runbookPath, tmpDir, "generated")
	require.NoError(t, err)
	defer executor.Close()

	// Inject an env var via the session
	err = executor.session.AppendToEnv(map[string]string{
		"MY_TOKEN": "secret-value",
	})
	require.NoError(t, err)

	assert.Equal(t, "secret-value", executor.getSessionEnvVar("MY_TOKEN"))
	assert.Equal(t, "", executor.getSessionEnvVar("NONEXISTENT_VAR"))
}

// =============================================================================
// detectAwsCredentials tests
// =============================================================================

func TestDetectAwsCredentials(t *testing.T) {
	tests := []struct {
		name           string
		prefix         string
		envVars        map[string]string
		expectFound    bool
		expectSource   AwsCredentialSource
		expectProfile  string
		expectRoleArn  string
	}{
		{
			name:   "env var credentials",
			prefix: "",
			envVars: map[string]string{
				"AWS_ACCESS_KEY_ID":     "AKIATEST",
				"AWS_SECRET_ACCESS_KEY": "secret",
			},
			expectFound:  true,
			expectSource: AwsCredSourceEnvVars,
		},
		{
			name:   "AWS_PROFILE",
			prefix: "",
			envVars: map[string]string{
				"AWS_PROFILE": "my-profile",
				"AWS_REGION":  "us-east-1",
			},
			expectFound:   true,
			expectSource:  AwsCredSourceProfile,
			expectProfile: "my-profile",
		},
		{
			name:   "OIDC web identity",
			prefix: "",
			envVars: map[string]string{
				"AWS_ROLE_ARN":                "arn:aws:iam::123456:role/test",
				"AWS_WEB_IDENTITY_TOKEN_FILE": "/tmp/token",
			},
			expectFound:   true,
			expectSource:  AwsCredSourceOIDC,
			expectRoleArn: "arn:aws:iam::123456:role/test",
		},
		{
			name:   "container credentials relative URI",
			prefix: "",
			envVars: map[string]string{
				"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/creds",
			},
			expectFound:  true,
			expectSource: AwsCredSourceContainerCreds,
		},
		{
			name:   "container credentials full URI",
			prefix: "",
			envVars: map[string]string{
				"AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://169.254.170.2/creds",
			},
			expectFound:  true,
			expectSource: AwsCredSourceContainerCreds,
		},
		{
			name:        "no credentials",
			prefix:      "",
			envVars:     map[string]string{},
			expectFound: false,
		},
		{
			name:   "prefixed env var credentials",
			prefix: "CI_",
			envVars: map[string]string{
				"CI_AWS_ACCESS_KEY_ID":     "AKIACITEST",
				"CI_AWS_SECRET_ACCESS_KEY": "ci-secret",
			},
			expectFound:  true,
			expectSource: AwsCredSourceEnvVars,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string {
				return tc.envVars[key]
			}

			_, info, found := detectAwsCredentials(tc.prefix, getenv)
			assert.Equal(t, tc.expectFound, found)
			if found {
				assert.Equal(t, tc.expectSource, info.Source)
				if tc.expectProfile != "" {
					assert.Equal(t, tc.expectProfile, info.ProfileName)
				}
				if tc.expectRoleArn != "" {
					assert.Equal(t, tc.expectRoleArn, info.RoleArn)
				}
			}
		})
	}
}

// =============================================================================
// parseTemplateInlineBlocks / parseTemplateBlocks with new fields
// =============================================================================

func TestParseTemplateInlineBlocks_NewFields(t *testing.T) {
	tmpDir := t.TempDir()
	content := `# Template Test

<TemplateInline outputPath="config.yaml" generateFile={true} target="worktree">
` + "```yaml" + `
key: value
` + "```" + `
</TemplateInline>

<TemplateInline outputPath="plain.txt">
` + "```" + `
plain content
` + "```" + `
</TemplateInline>
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(content), 0644))

	blocks, err := parseTemplateInlineBlocks(runbookPath)
	require.NoError(t, err)

	// Use GenerateTemplateInlineID to get the real IDs (they include a hash suffix)
	configID := GenerateTemplateInlineID("config.yaml")
	plainID := GenerateTemplateInlineID("plain.txt")

	// First block: generateFile=true, target=worktree
	configBlock := blocks[configID]
	require.NotNil(t, configBlock, "should parse config.yaml block (id=%s)", configID)
	assert.True(t, configBlock.GenerateFile, "generateFile should be true")
	assert.Equal(t, "worktree", configBlock.Target, "target should be worktree")

	// Second block: defaults (generateFile=false, target empty)
	plainBlock := blocks[plainID]
	require.NotNil(t, plainBlock, "should parse plain.txt block (id=%s)", plainID)
	assert.False(t, plainBlock.GenerateFile, "generateFile should default to false")
	assert.Equal(t, "", plainBlock.Target, "target should be empty by default")
}

func TestParseTemplateBlocks_TargetField(t *testing.T) {
	tmpDir := t.TempDir()
	content := `# Template Test

<Template id="worktree-tmpl" path="templates/my-template" target="worktree" />
<Template id="default-tmpl" path="templates/other" />
`
	runbookPath := filepath.Join(tmpDir, "runbook.mdx")
	require.NoError(t, os.WriteFile(runbookPath, []byte(content), 0644))

	blocks, err := parseTemplateBlocks(runbookPath)
	require.NoError(t, err)

	worktreeBlock := blocks["worktree-tmpl"]
	require.NotNil(t, worktreeBlock)
	assert.Equal(t, "worktree", worktreeBlock.Target)

	defaultBlock := blocks["default-tmpl"]
	require.NotNil(t, defaultBlock)
	assert.Equal(t, "", defaultBlock.Target)
}
