package watcher_test

import (
	"reflect"
	"testing"

	"github.com/gruntwork-io/runbooks/core/watcher"
)

func TestClassifyDetectsAddedModifiedRemoved(t *testing.T) {
	baseline := watcher.Snapshot{
		"gruntbook.mdx":     "aaa",
		"scripts/run.sh":    "bbb",
		"templates/main.tf": "ccc",
	}
	current := watcher.Snapshot{
		"gruntbook.mdx":     "aaa",   // unchanged — must be omitted
		"scripts/run.sh":    "bbb-x", // modified
		"scripts/new.sh":    "ddd",   // added
		// templates/main.tf removed
	}

	got := watcher.Classify(baseline, current)
	want := []watcher.DriftChange{
		{Path: "scripts/new.sh", Kind: watcher.DriftAdded},
		{Path: "scripts/run.sh", Kind: watcher.DriftModified},
		{Path: "templates/main.tf", Kind: watcher.DriftRemoved},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Classify mismatch:\n  got:  %v\n  want: %v", got, want)
	}
}

func TestClassifyEmptyWhenIdentical(t *testing.T) {
	snap := watcher.Snapshot{"a": "1", "b": "2"}
	got := watcher.Classify(snap, snap)
	if len(got) != 0 {
		t.Errorf("identical snapshots should produce zero changes, got %v", got)
	}
}

func TestClassifyNilBaselineTreatsAllAsAdded(t *testing.T) {
	current := watcher.Snapshot{"a": "1", "b": "2"}
	got := watcher.Classify(nil, current)
	if len(got) != 2 {
		t.Fatalf("expected 2 added, got %v", got)
	}
	for _, c := range got {
		if c.Kind != watcher.DriftAdded {
			t.Errorf("expected added, got %v for %s", c.Kind, c.Path)
		}
	}
}

func TestClassifyOutputIsDeterministicallySorted(t *testing.T) {
	baseline := watcher.Snapshot{"z": "1", "a": "2"}
	current := watcher.Snapshot{"z": "1-x", "a": "2-x"}

	got := watcher.Classify(baseline, current)
	if got[0].Path != "a" || got[1].Path != "z" {
		t.Errorf("expected sorted output [a, z], got %v", got)
	}
}
