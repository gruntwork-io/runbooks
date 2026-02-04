package testing

import (
	"os"
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

func TestGetTestEnvPrefix(t *testing.T) {
	tests := []struct {
		name           string
		props          string
		expectedPrefix string
	}{
		{
			name:           "no detectCredentials prop",
			props:          `id="aws-auth"`,
			expectedPrefix: "",
		},
		{
			name:           "detectCredentials with testPrefix single quotes",
			props:          `id="aws-auth" detectCredentials={[{ env: { testPrefix: 'CI_' } }]}`,
			expectedPrefix: "CI_",
		},
		{
			name:           "detectCredentials with testPrefix double quotes",
			props:          `id="aws-auth" detectCredentials={[{ env: { testPrefix: "CI_" } }]}`,
			expectedPrefix: "CI_",
		},
		{
			name:           "detectCredentials with prefix only (fallback)",
			props:          `id="aws-auth" detectCredentials={[{ env: { prefix: 'PROD_' } }]}`,
			expectedPrefix: "PROD_",
		},
		{
			name:           "detectCredentials with both prefix and testPrefix (testPrefix wins)",
			props:          `id="aws-auth" detectCredentials={[{ env: { prefix: 'PROD_', testPrefix: 'CI_' } }]}`,
			expectedPrefix: "CI_",
		},
		{
			name:           "detectCredentials with testPrefix first, prefix second",
			props:          `id="aws-auth" detectCredentials={[{ env: { testPrefix: 'TEST_', prefix: 'PROD_' } }]}`,
			expectedPrefix: "TEST_",
		},
		{
			name:           "detectCredentials as false",
			props:          `id="aws-auth" detectCredentials={false}`,
			expectedPrefix: "",
		},
		{
			name:           "detectCredentials as env string",
			props:          `id="aws-auth" detectCredentials={['env']}`,
			expectedPrefix: "",
		},
		{
			name:           "detectCredentials with block source (no prefix)",
			props:          `id="aws-auth" detectCredentials={[{ block: 'assume-role' }]}`,
			expectedPrefix: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			block := api.ParsedComponent{
				Props: tc.props,
			}
			prefix := getTestEnvPrefix(block)
			assert.Equal(t, tc.expectedPrefix, prefix)
		})
	}
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
			// Set up environment
			for k, v := range tc.envVars {
				t.Setenv(k, v)
			}

			creds, found, err := api.ReadAwsEnvCredentials(tc.prefix)

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
