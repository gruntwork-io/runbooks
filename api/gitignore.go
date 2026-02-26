package api

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// gitignoreRules holds parsed .gitignore patterns from an output directory.
// It supports the most common patterns: exact names, directory-only matches,
// glob patterns, negation, and rooted patterns.
type gitignoreRules struct {
	patterns []gitignorePattern
}

type gitignorePattern struct {
	pattern string
	negated bool
	dirOnly bool // pattern had trailing "/" — only matches directories
	rooted  bool // pattern had leading "/" — only matches at root level
}

// loadGitignore reads and parses a .gitignore file from the given directory.
// Returns nil if no .gitignore file exists or it contains no patterns.
func loadGitignore(dir string) *gitignoreRules {
	f, err := os.Open(filepath.Join(dir, ".gitignore"))
	if err != nil {
		return nil
	}
	defer f.Close()

	var patterns []gitignorePattern
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		p := gitignorePattern{}

		// Negation
		if strings.HasPrefix(line, "!") {
			p.negated = true
			line = line[1:]
		}

		// Rooted pattern (leading /)
		if strings.HasPrefix(line, "/") {
			p.rooted = true
			line = line[1:]
		}

		// Directory-only pattern (trailing /)
		if strings.HasSuffix(line, "/") {
			p.dirOnly = true
			line = strings.TrimSuffix(line, "/")
		}

		if line != "" {
			p.pattern = line
			patterns = append(patterns, p)
		}
	}

	if len(patterns) == 0 {
		return nil
	}
	return &gitignoreRules{patterns: patterns}
}

// isIgnored checks whether an entry should be excluded from the file tree.
// name is the entry's base name, isDir indicates if it's a directory,
// and relativePath is the slash-separated path relative to the root
// (e.g. "src/utils" for a file at src/utils/helper.go whose name is "helper.go").
func (g *gitignoreRules) isIgnored(name string, isDir bool, relativePath string) bool {
	if g == nil {
		return false
	}

	ignored := false
	for _, p := range g.patterns {
		// Dir-only patterns skip non-directories
		if p.dirOnly && !isDir {
			continue
		}

		matched := false
		if p.rooted {
			// Rooted patterns: match against the full relative path of the entry
			entryPath := relativePath
			if entryPath == "" {
				entryPath = name
			} else {
				entryPath = entryPath + "/" + name
			}
			matched, _ = filepath.Match(p.pattern, entryPath)
		} else {
			// Unrooted patterns: match against the base name only
			matched, _ = filepath.Match(p.pattern, name)
		}

		if matched {
			ignored = !p.negated
		}
	}
	return ignored
}
