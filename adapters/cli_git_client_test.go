package adapters

import (
	"reflect"
	"testing"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// ---------------------------------------------------------------------------
// buildCloneArgs
// ---------------------------------------------------------------------------

func TestBuildCloneArgs_NoRef(t *testing.T) {
	args := buildCloneArgs("https://github.com/org/repo.git", "/tmp/dest", "")
	want := []string{"clone", "--progress", "https://github.com/org/repo.git", "/tmp/dest"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("buildCloneArgs = %v, want %v", args, want)
	}
}

func TestBuildCloneArgs_WithRef(t *testing.T) {
	args := buildCloneArgs("https://github.com/org/repo.git", "/tmp/dest", "main")
	want := []string{"clone", "--progress", "--branch", "main", "https://github.com/org/repo.git", "/tmp/dest"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("buildCloneArgs with ref = %v, want %v", args, want)
	}
}

func TestBuildCloneArgs_URLAndDestPreserved(t *testing.T) {
	url := "https://token@github.com/org/private.git"
	dest := "/home/user/workspace/project"
	args := buildCloneArgs(url, dest, "")
	// URL must appear before destPath
	last2 := args[len(args)-2:]
	if last2[0] != url || last2[1] != dest {
		t.Errorf("expected last two args to be [%q, %q], got %v", url, dest, last2)
	}
}

// ---------------------------------------------------------------------------
// buildSparseCloneSteps
// ---------------------------------------------------------------------------

func TestBuildSparseCloneSteps_AlwaysThreeSteps(t *testing.T) {
	steps := buildSparseCloneSteps("https://github.com/org/repo.git", "/tmp/dest", "modules/vpc", "")
	if len(steps) != 3 {
		t.Fatalf("buildSparseCloneSteps returned %d steps, want 3", len(steps))
	}
}

func TestBuildSparseCloneSteps_NoRef(t *testing.T) {
	steps := buildSparseCloneSteps("https://github.com/org/repo.git", "/tmp/dest", "modules/vpc", "")

	cloneArgs := steps[0].args
	// Must contain filter and no-checkout flags
	if !containsAll(cloneArgs, []string{"--filter=blob:none", "--no-checkout", "--progress"}) {
		t.Errorf("step 0 args %v missing required sparse-clone flags", cloneArgs)
	}
	// Must NOT contain --branch when ref is empty
	if contains(cloneArgs, "--branch") {
		t.Errorf("step 0 args %v contains --branch but no ref was given", cloneArgs)
	}
	// URL and dest must be the last two elements
	last2 := cloneArgs[len(cloneArgs)-2:]
	if last2[0] != "https://github.com/org/repo.git" || last2[1] != "/tmp/dest" {
		t.Errorf("step 0 args last two = %v, want [url, dest]", last2)
	}
}

func TestBuildSparseCloneSteps_WithRef(t *testing.T) {
	steps := buildSparseCloneSteps("https://github.com/org/repo.git", "/tmp/dest", "modules/vpc", "v1.2.3")

	cloneArgs := steps[0].args
	if !containsSequence(cloneArgs, []string{"--branch", "v1.2.3"}) {
		t.Errorf("step 0 args %v missing '--branch v1.2.3'", cloneArgs)
	}
}

func TestBuildSparseCloneSteps_SparseCheckoutSet(t *testing.T) {
	repoPath := "modules/vpc"
	destPath := "/tmp/dest"
	steps := buildSparseCloneSteps("https://github.com/org/repo.git", destPath, repoPath, "")

	setArgs := steps[1].args
	// Must be: -C <destPath> sparse-checkout set <repoPath>
	want := []string{"-C", destPath, "sparse-checkout", "set", repoPath}
	if !reflect.DeepEqual(setArgs, want) {
		t.Errorf("step 1 args = %v, want %v", setArgs, want)
	}
	if steps[1].errWrap != "sparse-checkout set failed" {
		t.Errorf("step 1 errWrap = %q, want %q", steps[1].errWrap, "sparse-checkout set failed")
	}
}

func TestBuildSparseCloneSteps_Checkout(t *testing.T) {
	destPath := "/tmp/dest"
	steps := buildSparseCloneSteps("https://github.com/org/repo.git", destPath, "sub", "")

	checkoutArgs := steps[2].args
	want := []string{"-C", destPath, "checkout"}
	if !reflect.DeepEqual(checkoutArgs, want) {
		t.Errorf("step 2 args = %v, want %v", checkoutArgs, want)
	}
	if steps[2].errWrap != "checkout failed" {
		t.Errorf("step 2 errWrap = %q, want %q", steps[2].errWrap, "checkout failed")
	}
}

func TestBuildSparseCloneSteps_ErrWrapsAreSet(t *testing.T) {
	steps := buildSparseCloneSteps("url", "dest", "path", "")
	wantWraps := []string{"sparse clone failed", "sparse-checkout set failed", "checkout failed"}
	for i, step := range steps {
		if step.errWrap != wantWraps[i] {
			t.Errorf("step[%d].errWrap = %q, want %q", i, step.errWrap, wantWraps[i])
		}
	}
}

// ---------------------------------------------------------------------------
// CliGitClient constructor
// ---------------------------------------------------------------------------

func TestNewCliGitClient_ImplementsInterface(t *testing.T) {
	c := NewCliGitClient()
	if c == nil {
		t.Fatal("NewCliGitClient returned nil")
	}
	// Compile-time check: if this assignment compiles, the interface is satisfied.
	var _ ports.GitClient = c
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func containsAll(slice []string, targets []string) bool {
	for _, t := range targets {
		if !contains(slice, t) {
			return false
		}
	}
	return true
}

// containsSequence reports whether needle appears as a contiguous sub-slice.
func containsSequence(haystack, needle []string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i <= len(haystack)-len(needle); i++ {
		if reflect.DeepEqual(haystack[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}