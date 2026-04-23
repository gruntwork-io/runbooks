package watcher

import "sort"

// DriftKind labels how a file differs between the baseline snapshot and
// the current tree.
type DriftKind string

const (
	DriftAdded    DriftKind = "added"
	DriftModified DriftKind = "modified"
	DriftRemoved  DriftKind = "removed"
)

// DriftChange is one path-level difference between two Snapshots.
type DriftChange struct {
	Path string    `json:"path"`
	Kind DriftKind `json:"kind"`
}

// Classify compares a baseline snapshot (taken when the gruntbook was
// opened) to a current snapshot and returns the set of differences.
// Content-identical writes — an editor saving a file without changing
// its bytes — produce the same SHA256 and are intentionally omitted so
// they don't trigger the consumer-mode drift banner.
//
// Output is sorted by path, then kind, for deterministic tests and
// stable UI rendering.
func Classify(baseline, current Snapshot) []DriftChange {
	out := []DriftChange{}
	for path, hash := range baseline {
		cur, ok := current[path]
		if !ok {
			out = append(out, DriftChange{Path: path, Kind: DriftRemoved})
			continue
		}
		if cur != hash {
			out = append(out, DriftChange{Path: path, Kind: DriftModified})
		}
	}
	for path := range current {
		if _, ok := baseline[path]; !ok {
			out = append(out, DriftChange{Path: path, Kind: DriftAdded})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}
