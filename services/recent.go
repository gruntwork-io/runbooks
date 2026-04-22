package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// maxRecentEntries caps the persisted list. Prevents unbounded growth
// and keeps the Welcome page tidy.
const maxRecentEntries = 20

// RecentEntry is one item in the recent-gruntbooks list. Exported for the
// Wails bindings generator.
type RecentEntry struct {
	// Path is the absolute on-disk path (for local) or the original URL
	// (for remote) that the user opened. The frontend uses this as the
	// stable identifier; clicking a recent entry passes it straight to
	// OpenLocal or OpenRemote.
	Path string `json:"path"`
	// DisplayName is a short label. For local entries this is the
	// directory name; for remote entries it's the last non-empty URL
	// segment. Falls back to Path if nothing better can be derived.
	DisplayName string `json:"displayName"`
	// IsRemote is true for git URLs, false for local paths. Lets the UI
	// show the right icon and dispatch to the right open action.
	IsRemote bool `json:"isRemote"`
	// LastOpened is when the entry was most recently opened.
	LastOpened time.Time `json:"lastOpened"`
}

// recentStore owns the JSON-on-disk recent list and serialises access
// to it. All methods are safe for concurrent use.
type recentStore struct {
	path string // absolute path to recent.json
	mu   sync.Mutex
}

// newRecentStore resolves the OS-appropriate app-data directory and
// returns a store rooted there. The directory is created lazily when
// the first entry is recorded, so a read-only environment (like a test
// sandbox) doesn't break just by constructing a store.
func newRecentStore() (*recentStore, error) {
	dir, err := appDataDir()
	if err != nil {
		return nil, err
	}
	return &recentStore{path: filepath.Join(dir, "recent.json")}, nil
}

// appDataDir returns the directory where Gruntbooks stores per-user
// state. os.UserConfigDir() is cross-platform: macOS puts us under
// ~/Library/Application Support, Linux under $XDG_CONFIG_HOME (or
// ~/.config), Windows under %AppData%.
func appDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(base, "Gruntbooks"), nil
}

// list returns the current entries sorted most-recent-first. A missing
// or unreadable file returns an empty slice (never an error): a brand-
// new install should just see "no recent gruntbooks yet".
func (s *recentStore) list() []RecentEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

// record upserts an entry and trims the list to maxRecentEntries. The
// entry's LastOpened is stamped to now so this doubles as "touch".
func (s *recentStore) record(e RecentEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries := s.readLocked()

	// Drop any existing entry for the same path so we don't create
	// duplicates when a user opens the same gruntbook repeatedly.
	filtered := entries[:0]
	for _, existing := range entries {
		if existing.Path != e.Path {
			filtered = append(filtered, existing)
		}
	}

	e.LastOpened = time.Now()
	filtered = append([]RecentEntry{e}, filtered...)
	if len(filtered) > maxRecentEntries {
		filtered = filtered[:maxRecentEntries]
	}

	return s.writeLocked(filtered)
}

// readLocked parses recent.json. Caller must hold s.mu.
func (s *recentStore) readLocked() []RecentEntry {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	var entries []RecentEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		// Corrupt file — log-and-forget semantics. We'd rather show an
		// empty list than bubble a JSON parse error up to the UI.
		return nil
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].LastOpened.After(entries[j].LastOpened)
	})
	return entries
}

// writeLocked serialises entries to recent.json via a rename-from-temp
// so a crash mid-write leaves the previous file intact. Caller must
// hold s.mu.
func (s *recentStore) writeLocked(entries []RecentEntry) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create app data dir: %w", err)
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal recent entries: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write recent entries: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("rename recent entries: %w", err)
	}
	return nil
}
