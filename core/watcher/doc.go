// Package watcher provides drift detection primitives for the
// always-watch gruntbook flow: a Snapshot of the gruntbook tree taken
// at open time, and a Classify function that diffs a current snapshot
// against the baseline to produce added / modified / removed changes.
//
// The consumer-mode drift banner in the desktop app uses this to flag
// that a gruntbook has changed on disk since the user opened it,
// without auto-reloading — protecting consumers from executing a
// different script than the one they reviewed. Author mode (future)
// hot-reloads instead.
//
// Everything in this package is OS-agnostic: file reads go through a
// ports.FileSystem so the same logic runs through OsFileSystem on the
// desktop and could run through a ChrootFileSystem in a hosted mode.
package watcher
