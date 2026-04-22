package core_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCoreHasNoForbiddenImports enforces the hostability invariant
// from the Wails rewrite plan: nothing under core/ may import
// OS-coupled packages. Adapters live in /adapters; domain code
// depends only on core/ports interfaces plus pure-stdlib packages.
//
// The check is implemented as a plain Go test — no golangci-lint,
// no depguard config — so the rule is self-contained and runs
// wherever `go test ./...` runs. When the M0 refactor brings more
// domain code under core/, this test is the backstop that prevents
// someone from "just this once" calling os.Getenv directly.
//
// _test.go files under core/ are exempt (tests can use anything);
// non-test files under core/ports/fakes/ are exempt because fakes
// are test support rather than shippable domain code.
func TestCoreHasNoForbiddenImports(t *testing.T) {
	// Note: net/url is intentionally NOT forbidden — it's pure string
	// parsing with no OS coupling. path/filepath is likewise permitted
	// for domain code that manipulates paths as strings (no I/O).
	forbidden := map[string]bool{
		"os":                              true,
		"os/exec":                         true,
		"os/user":                         true,
		"syscall":                         true,
		"net":                             true,
		"net/http":                        true,
		"github.com/gin-gonic/gin":        true,
		"github.com/creack/pty":           true,
		"github.com/fsnotify/fsnotify":    true,
		"github.com/mixpanel/mixpanel-go": true,
	}
	forbiddenPrefixes := []string{
		"github.com/aws/aws-sdk-go-v2/",
		"github.com/gin-contrib/",
	}

	// Resolve the core/ directory regardless of the test's working
	// directory (go test chdirs into the package under test).
	coreDir, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("resolve core dir: %v", err)
	}
	// core_test runs from core/, so "." is already core/.

	fset := token.NewFileSet()

	var violations []string
	walkErr := filepath.Walk(coreDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			// Fakes are test support; they may pull in anything a fake needs.
			if filepath.Base(path) == "fakes" && filepath.Base(filepath.Dir(path)) == "ports" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}

		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range file.Imports {
			// imp.Path.Value is a quoted string literal; strip the quotes.
			importPath := strings.Trim(imp.Path.Value, `"`)
			if forbidden[importPath] {
				rel, _ := filepath.Rel(coreDir, path)
				violations = append(violations, rel+": imports "+importPath)
				continue
			}
			for _, prefix := range forbiddenPrefixes {
				if strings.HasPrefix(importPath, prefix) {
					rel, _ := filepath.Rel(coreDir, path)
					violations = append(violations, rel+": imports "+importPath)
					break
				}
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk core/: %v", walkErr)
	}

	if len(violations) > 0 {
		t.Fatalf("forbidden OS-coupled imports under core/:\n\t%s\n\n"+
			"Domain code must depend only on core/ports interfaces and pure-stdlib\n"+
			"packages. Move OS-coupled code to /adapters and depend on a port.",
			strings.Join(violations, "\n\t"))
	}
}
