package services

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/core/watcher"
)

// WatcherService is the Wails IPC wrapper around the file-change
// notifications the legacy /api/watch SSE endpoint emitted.
//
// Each StartWatch returns a watchID the frontend subscribes to for
// two topics:
//
//   - `watch:<watchID>:change` — raw file-change events for the
//     resolved gruntbook file. Used by author-mode auto-reload
//     (today's `gruntbooks watch` behaviour).
//   - `watch:<watchID>:drift` — classified drift events vs. the
//     snapshot captured at StartWatch time. Consumer-mode shows a
//     non-blocking banner on these so reviewers notice scripts
//     changing out from under them.
//
// Stop / Cancel are idempotent so frontend unmount handlers don't have
// to track whether StartWatch succeeded.
type WatcherService struct {
	emitter ports.Emitter
	fsys    ports.FileSystem

	mu      sync.Mutex
	watches map[string]*watchState
}

// watchState is the per-watch bookkeeping. baseline is protected by mu
// because ResetSnapshot can replace it concurrently with the run()
// goroutine reading it on a change event.
type watchState struct {
	close    func()
	root     string
	mu       sync.Mutex
	baseline watcher.Snapshot
}

// NewWatcherService constructs the service. It depends on a FileSystem
// port so the same snapshot logic can run under a hosted adapter later
// without the service changing shape.
func NewWatcherService(emitter ports.Emitter) *WatcherService {
	return &WatcherService{
		emitter: emitter,
		fsys:    adapters.NewOsFileSystem(),
		watches: make(map[string]*watchState),
	}
}

// ServiceName satisfies application.ServiceName.
func (s *WatcherService) ServiceName() string { return "WatcherService" }

// WatchStartRequest is the IPC input for StartWatch.
type WatchStartRequest struct {
	// Path is the gruntbook file to watch. Resolved through
	// api.ResolveGruntbookPath so the frontend can pass a directory and
	// have it land on gruntbook.mdx (or legacy runbook.mdx).
	Path string `json:"path"`

	// OutputRelPath, if non-empty, is the gruntbook-root-relative path
	// where the gruntbook writes generated artefacts. Excluded from the
	// snapshot so drift doesn't fire every time a Command block runs.
	OutputRelPath string `json:"outputRelPath,omitempty"`
}

// WatchStartResult is the IPC output of StartWatch. WatchID is the
// handle the frontend uses to subscribe to `watch:<watchID>:change` /
// `watch:<watchID>:drift` events and to call Stop later.
type WatchStartResult struct {
	WatchID      string `json:"watchId"`
	ResolvedPath string `json:"resolvedPath"`
}

// WatchChangeEvent is the payload of `watch:<watchID>:change`. Emitted
// after the 300ms debounce mirroring the legacy FileWatcher. Op is the
// raw fsnotify op string ("WRITE", "CREATE") so author-mode UIs can
// branch on it without a second round-trip.
type WatchChangeEvent struct {
	Path string `json:"path"`
	Op   string `json:"op"`
	At   string `json:"at"`
}

// WatchDriftEvent is the payload of `watch:<watchID>:drift`. Changes
// is the full cumulative delta since the snapshot was taken (or last
// reset via ResetSnapshot) — not just the latest edit. Empty Changes
// means the current tree matches the baseline; we don't emit those.
type WatchDriftEvent struct {
	Changes []watcher.DriftChange `json:"changes"`
	At      string                `json:"at"`
}

// watchDebounce mirrors the legacy 300ms window so editor save-storms
// collapse to a single event.
const watchDebounce = 300 * time.Millisecond

// StartWatch begins watching a gruntbook for changes. Captures an
// initial snapshot of the whole tree (excluding .git/node_modules/
// and the optional output path) and recursively adds every
// subdirectory to the fsnotify watcher so edits anywhere in the
// gruntbook produce drift events. The caller MUST eventually call
// Stop(watchID) to release the fsnotify watcher.
func (s *WatcherService) StartWatch(req WatchStartRequest) (*WatchStartResult, error) {
	resolved, err := api.ResolveGruntbookPath(req.Path)
	if err != nil {
		return nil, fmt.Errorf("resolve gruntbook path: %w", err)
	}
	root := filepath.Dir(resolved)

	baseline, err := watcher.Walk(s.fsys, root, req.OutputRelPath)
	if err != nil {
		return nil, fmt.Errorf("initial snapshot: %w", err)
	}

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}
	if err := addDirsRecursive(fsw, root); err != nil {
		_ = fsw.Close()
		return nil, fmt.Errorf("watch dirs: %w", err)
	}

	watchID, err := newRunID()
	if err != nil {
		_ = fsw.Close()
		return nil, fmt.Errorf("allocate watch id: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	state := &watchState{
		root:     root,
		baseline: baseline,
		close: func() {
			cancel()
			_ = fsw.Close()
		},
	}
	s.mu.Lock()
	s.watches[watchID] = state
	s.mu.Unlock()

	go s.run(ctx, watchID, resolved, req.OutputRelPath, state, fsw)

	return &WatchStartResult{WatchID: watchID, ResolvedPath: resolved}, nil
}

// Stop cancels an in-flight watcher. Idempotent no-op on unknown IDs so
// frontend unmount handlers don't have to track whether Start succeeded.
func (s *WatcherService) Stop(watchID string) error {
	s.mu.Lock()
	state := s.watches[watchID]
	delete(s.watches, watchID)
	s.mu.Unlock()
	if state == nil {
		return nil
	}
	state.close()
	return nil
}

// ResetSnapshot re-walks the gruntbook tree and replaces the baseline
// for an active watch. The frontend calls this after the user clicks
// "Reload" on the drift banner so a subsequent edit is measured against
// the just-reloaded state rather than the original open. Returns nil
// on unknown IDs (the watch already stopped).
func (s *WatcherService) ResetSnapshot(req WatchResetRequest) error {
	s.mu.Lock()
	state := s.watches[req.WatchID]
	s.mu.Unlock()
	if state == nil {
		return nil
	}
	snap, err := watcher.Walk(s.fsys, state.root, req.OutputRelPath)
	if err != nil {
		return fmt.Errorf("reset snapshot: %w", err)
	}
	state.mu.Lock()
	state.baseline = snap
	state.mu.Unlock()
	return nil
}

// WatchResetRequest is the IPC input for ResetSnapshot.
type WatchResetRequest struct {
	WatchID       string `json:"watchId"`
	OutputRelPath string `json:"outputRelPath,omitempty"`
}

func (s *WatcherService) run(
	ctx context.Context,
	watchID, target, outputRelPath string,
	state *watchState,
	fsw *fsnotify.Watcher,
) {
	changeTopic := fmt.Sprintf("watch:%s:change", watchID)
	driftTopic := fmt.Sprintf("watch:%s:drift", watchID)

	var debounceTimer *time.Timer
	var lastChangePath, lastChangeOp string

	for {
		select {
		case <-ctx.Done():
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return

		case event, ok := <-fsw.Events:
			if !ok {
				return
			}

			// fsnotify is non-recursive; mirror the tree by adding any
			// new subdirectory as it appears. Best-effort — failures
			// log but don't abort the watch.
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					if addErr := fsw.Add(event.Name); addErr != nil {
						slog.Warn("watcher: add new subdir", "path", event.Name, "error", addErr)
					}
				}
			}

			// Filter: only forward events for writes/creates/renames/removes.
			// Chmod and other metadata-only ops don't change content hashes.
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}

			slog.Info("watcher: fs event", "path", event.Name, "op", event.Op)
			lastChangePath = event.Name
			lastChangeOp = event.Op.String()
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			debounceTimer = time.AfterFunc(watchDebounce, func() {
				s.onDebouncedChange(state, changeTopic, driftTopic, target, outputRelPath, lastChangePath, lastChangeOp)
			})

		case err, ok := <-fsw.Errors:
			if !ok {
				return
			}
			slog.Error("watcher: fsnotify error", "error", err)
		}
	}
}

// onDebouncedChange fires after the 300ms quiet period. Emits:
//   - :change if the target gruntbook file itself was edited (legacy
//     auto-reload path)
//   - :drift with the classified delta vs. the baseline snapshot
//     whenever the tree differs from the baseline. Content-identical
//     writes produce an empty delta and are silently dropped.
func (s *WatcherService) onDebouncedChange(
	state *watchState,
	changeTopic, driftTopic, target, outputRelPath, lastPath, lastOp string,
) {
	now := time.Now().Format(time.RFC3339)

	if lastPath == target {
		_ = s.emitter.Emit(changeTopic, WatchChangeEvent{
			Path: target,
			Op:   lastOp,
			At:   now,
		})
	}

	current, err := watcher.Walk(s.fsys, state.root, outputRelPath)
	if err != nil {
		slog.Warn("watcher: re-snapshot failed", "error", err)
		return
	}
	state.mu.Lock()
	changes := watcher.Classify(state.baseline, current)
	state.mu.Unlock()
	if len(changes) == 0 {
		return
	}
	_ = s.emitter.Emit(driftTopic, WatchDriftEvent{Changes: changes, At: now})
}

// addDirsRecursive walks root and registers every directory with the
// fsnotify watcher. Skips .git / node_modules / .DS_Store to keep the
// watch set bounded — they match the Walk exclusions so a file
// excluded from the snapshot also can't generate a watcher event that
// we'd have to re-hash and discard.
func addDirsRecursive(fsw *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if path != root {
			if name == ".git" || name == "node_modules" || name == ".DS_Store" {
				return filepath.SkipDir
			}
		}
		return fsw.Add(path)
	})
}
