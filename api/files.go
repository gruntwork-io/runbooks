package api

import (
	"os"
	"path/filepath"
	"strings"
)

// IsTfModule checks if a directory contains .tf files (and no runbook.mdx/md).
// This is used to detect OpenTofu modules so we can auto-generate a runbook.
func IsTfModule(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return false
	}

	hasTF := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		lower := strings.ToLower(name)

		// If there's already a runbook, this is not a bare TF module
		if lower == "runbook.mdx" || lower == "runbook.md" {
			return false
		}

		if filepath.Ext(lower) == ".tf" {
			hasTF = true
		}
	}

	return hasTF
}
