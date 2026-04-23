package watcher

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// Snapshot maps a gruntbook-root-relative path to the SHA256 hex of the
// file contents at snapshot time. Paths use forward slashes regardless
// of host OS so the frontend can compare them identically across
// platforms.
type Snapshot map[string]string

// excludedDirNames lists directories we skip entirely during Walk.
// They either contain content the user wouldn't reasonably edit
// (.git, node_modules) or aren't content at all (.DS_Store which can
// appear as a directory on some mounts). Skipping them keeps snapshot
// cost bounded on gruntbooks with vendored dependencies — node_modules
// alone can be 50k files, none of which matter for drift detection.
var excludedDirNames = map[string]bool{
	".git":         true,
	"node_modules": true,
	".DS_Store":    true,
}

// Walk computes a Snapshot of the tree rooted at root. outputRelPath,
// if non-empty, is a gruntbook-root-relative path the gruntbook writes
// generated files to (e.g. "generated/") — excluded so the snapshot
// doesn't churn every time a Command block runs. Unreadable files are
// silently skipped rather than aborting the walk: a transient
// permission error on an unrelated file shouldn't break drift
// detection for everything else.
//
// The returned Snapshot is safe to hand to Classify — it's a plain
// map[string]string with no pointers to fsys state.
func Walk(fsys ports.FileSystem, root string, outputRelPath string) (Snapshot, error) {
	snap := Snapshot{}
	outputRelPath = filepath.ToSlash(strings.TrimSpace(outputRelPath))

	err := fsys.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Descend errors (e.g. unreadable subdir) shouldn't fail the
			// whole snapshot — skip and continue.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)

		if d.IsDir() {
			if rel == "." {
				return nil
			}
			if excludedDirNames[d.Name()] {
				return fs.SkipDir
			}
			if outputRelPath != "" && (relSlash == outputRelPath || strings.HasPrefix(relSlash+"/", outputRelPath+"/")) {
				return fs.SkipDir
			}
			return nil
		}

		if d.Name() == ".DS_Store" {
			return nil
		}

		data, readErr := fsys.Read(path)
		if readErr != nil {
			return nil
		}
		sum := sha256.Sum256(data)
		snap[relSlash] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		return nil, err
	}
	return snap, nil
}
