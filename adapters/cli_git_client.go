package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// CliGitClient is the production GitClient, backed by the `git`
// CLI on PATH. A hosted deployment could swap in a libgit2-backed
// or sandboxed implementation without touching callers.
type CliGitClient struct{}

// NewCliGitClient constructs a CliGitClient. No configuration is
// needed — `git` is expected to be on PATH (callers that care
// should verify this up front).
func NewCliGitClient() *CliGitClient {
	return &CliGitClient{}
}

// Clone runs `git clone`, or a three-step sparse-checkout sequence
// when req.RepoPath is non-empty. Combined stdout+stderr is returned
// so callers can classify auth / network / ref-not-found failures.
func (c *CliGitClient) Clone(ctx context.Context, req ports.GitCloneRequest) ([]byte, error) {
	if req.RepoPath != "" {
		return runSparseClone(ctx, req)
	}
	return runStandardClone(ctx, req)
}

func runStandardClone(ctx context.Context, req ports.GitCloneRequest) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", buildCloneArgs(req.URL, req.DestPath, req.Ref)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%w: %s", err, string(output))
	}
	return output, nil
}

func runSparseClone(ctx context.Context, req ports.GitCloneRequest) ([]byte, error) {
	for _, step := range buildSparseCloneSteps(req.URL, req.DestPath, req.RepoPath, req.Ref) {
		cmd := exec.CommandContext(ctx, "git", step.args...)
		if output, err := cmd.CombinedOutput(); err != nil {
			return output, fmt.Errorf("%s: %w: %s", step.errWrap, err, string(output))
		}
	}
	return nil, nil
}

// sparseCloneStep is one phase of a sparse checkout (clone, configure,
// checkout). The struct mirrors the one in api/git_clone.go so the
// adapter and that package can stay in sync until the streaming path
// is also ported.
type sparseCloneStep struct {
	args    []string
	errWrap string
}

func buildCloneArgs(cloneURL, destPath, ref string) []string {
	args := []string{"clone", "--progress"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	return append(args, cloneURL, destPath)
}

func buildSparseCloneSteps(cloneURL, destPath, repoPath, ref string) []sparseCloneStep {
	cloneArgs := []string{"clone", "--filter=blob:none", "--no-checkout", "--progress"}
	if ref != "" {
		cloneArgs = append(cloneArgs, "--branch", ref)
	}
	cloneArgs = append(cloneArgs, cloneURL, destPath)

	return []sparseCloneStep{
		{args: cloneArgs, errWrap: "sparse clone failed"},
		{args: []string{"-C", destPath, "sparse-checkout", "set", repoPath}, errWrap: "sparse-checkout set failed"},
		{args: []string{"-C", destPath, "checkout"}, errWrap: "checkout failed"},
	}
}

var _ ports.GitClient = (*CliGitClient)(nil)
