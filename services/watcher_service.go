package services

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// WatcherService is the Wails IPC wrapper around the file-change
// notifications the legacy /api/watch SSE endpoint emitted.
//
// Each Start returns a watchID the frontend subscribes to for
// `watch:<watchID>:change` events. The payload is a single flat shape
// (`{path, op, at}`) — richer than the SSE version's bare "reload"
// string so author-mode UIs can distinguish script edits from
// gruntbook.mdx edits without re-parsing. Stop cancels the watcher;
// Cancel is idempotent so unmount handlers don't have to track state.
//
// M5's drift detection (snapshot + classify) will layer on top by
// subscribing to these change events and publishing `watch:<watchID>:drift`
// alongside them. For now this service emits raw file changes only.
type WatcherService struct {
	emitter ports.Emitter

	mu      sync.Mutex
	watches map[string]context.CancelFunc
}

// NewWatcherService constructs the service. Unlike ExecService / GitService
// it doesn't need the serverManager — file paths come in from the
// frontend, and the watcher doesn't care which gruntbook is "open."
func NewWatcherService(emitter ports.Emitter) *WatcherService {
	return &WatcherService{
		emitter: emitter,
		watches: make(map[string]context.CancelFunc),
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
}

// WatchStartResult is the IPC output of StartWatch. WatchID is the
// handle the frontend uses to subscribe to `watch:<watchID>:change`
// events and to call Stop later.
type WatchStartResult struct {
	WatchID      string `json:"watchId"`
	ResolvedPath string `json:"resolvedPath"`
}

// WatchChangeEvent is the payload of `watch:<watchID>:change`. Emitted
// after the 300ms debounce mirroring the legacy FileWatcher. Op is the
// raw fsnotify op string ("WRITE", "CREATE") so author-mode UIs can
// branch on it without having a second round-trip.
type WatchChangeEvent struct {
	Path string `json:"path"`
	Op   string `json:"op"`
	At   string `json:"at"`
}

// watchDebounce mirrors the legacy 300ms window so editor save-storms
// collapse to a single event.
const watchDebounce = 300 * time.Millisecond

// StartWatch begins watching a gruntbook file for changes. Returns a
// watchID the frontend can subscribe to; the caller MUST eventually
// call Stop(watchID) to release the fsnotify watcher.
func (s *WatcherService) StartWatch(req WatchStartRequest) (*WatchStartResult, error) {
	resolved, err := api.ResolveGruntbookPath(req.Path)
	if err != nil {
		return nil, fmt.Errorf("resolve gruntbook path: %w", err)
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create fsnotify watcher: %w", err)
	}

	// fsnotify watches directories; editor atomic-save-and-rename flows
	// fire events on the parent dir for our file name.
	dir := filepath.Dir(resolved)
	if err := watcher.Add(dir); err != nil {
		_ = watcher.Close()
		return nil, fmt.Errorf("watch %q: %w", dir, err)
	}

	watchID, err := newRunID()
	if err != nil {
		_ = watcher.Close()
		return nil, fmt.Errorf("allocate watch id: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.watches[watchID] = func() {
		cancel()
		_ = watcher.Close()
	}
	s.mu.Unlock()

	go s.run(ctx, watchID, resolved, watcher)

	return &WatchStartResult{WatchID: watchID, ResolvedPath: resolved}, nil
}

// Stop cancels an in-flight watcher. Idempotent no-op on unknown IDs so
// frontend unmount handlers don't have to track whether Start succeeded.
func (s *WatcherService) Stop(watchID string) error {
	s.mu.Lock()
	cancel := s.watches[watchID]
	delete(s.watches, watchID)
	s.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	return nil
}

func (s *WatcherService) run(ctx context.Context, watchID, target string, watcher *fsnotify.Watcher) {
	topic := fmt.Sprintf("watch:%s:change", watchID)

	var debounceTimer *time.Timer

	for {
		select {
		case <-ctx.Done():
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return

		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Name != target {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			slog.Info("watcher: file change", "path", event.Name, "op", event.Op)
			// Capture op into a local so the timer goroutine doesn't race
			// with the next loop iteration updating a shared variable.
			opStr := event.Op.String()
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			debounceTimer = time.AfterFunc(watchDebounce, func() {
				_ = s.emitter.Emit(topic, WatchChangeEvent{
					Path: target,
					Op:   opStr,
					At:   time.Now().Format(time.RFC3339),
				})
			})

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			slog.Error("watcher: fsnotify error", "error", err)
		}
	}
}
