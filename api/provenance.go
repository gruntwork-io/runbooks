package api

import (
	"bytes"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// ProvenanceStore tracks which block last modified each file.
// It is an in-memory map scoped to a session, cleared on session reset.
type ProvenanceStore struct {
	mu    sync.RWMutex
	files map[string]FileProvenance // absolutePath -> provenance
}

// FileProvenance records which block last modified a file.
type FileProvenance struct {
	BlockID   string `json:"sourceBlockId"`
	BlockType string `json:"sourceBlockType"` // "template", "command", "check"
}

// NewProvenanceStore creates a new empty provenance store.
func NewProvenanceStore() *ProvenanceStore {
	return &ProvenanceStore{
		files: make(map[string]FileProvenance),
	}
}

// Record sets the provenance for a list of file paths.
// Last writer wins: if two blocks modify the same file, the second call replaces the first.
func (ps *ProvenanceStore) Record(blockID, blockType string, filePaths []string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	prov := FileProvenance{
		BlockID:   blockID,
		BlockType: blockType,
	}

	for _, path := range filePaths {
		ps.files[path] = prov
	}
}

// Get looks up provenance for a single file path.
// Returns nil if no provenance is recorded for this path.
func (ps *ProvenanceStore) Get(filePath string) *FileProvenance {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	if prov, ok := ps.files[filePath]; ok {
		return &prov
	}
	return nil
}

// Clear removes all recorded provenance.
func (ps *ProvenanceStore) Clear() {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.files = make(map[string]FileProvenance)
}

// SnapshotGitStatus captures git status for a list of worktree paths.
// Returns a map of worktreePath -> set of changed file absolute paths.
func SnapshotGitStatus(workTreePaths []string) map[string]map[string]bool {
	result := make(map[string]map[string]bool, len(workTreePaths))

	for _, wtPath := range workTreePaths {
		files := make(map[string]bool)
		cmd := exec.Command("git", "status", "--porcelain")
		cmd.Dir = wtPath

		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		if err := cmd.Run(); err != nil {
			continue // Skip this worktree on error
		}

		for _, line := range strings.Split(strings.TrimRight(stdout.String(), "\n\r "), "\n") {
			if len(line) < 4 {
				continue
			}
			filePath := strings.TrimSpace(line[3:])
			// Handle renamed files
			if idx := strings.Index(filePath, " -> "); idx >= 0 {
				filePath = filePath[idx+4:]
			}
			absPath := filepath.Join(wtPath, filePath)
			files[absPath] = true
		}

		result[wtPath] = files
	}

	return result
}

// DiffAndRecord compares before/after git status snapshots and records provenance for newly changed files.
func DiffAndRecord(ps *ProvenanceStore, blockID, blockType string, before, after map[string]map[string]bool) {
	if ps == nil {
		return
	}

	for wtPath, afterFiles := range after {
		beforeFiles := before[wtPath]
		var newlyChanged []string

		for absPath := range afterFiles {
			if !beforeFiles[absPath] {
				newlyChanged = append(newlyChanged, absPath)
			}
		}

		if len(newlyChanged) > 0 {
			ps.Record(blockID, blockType, newlyChanged)
		}
	}
}
