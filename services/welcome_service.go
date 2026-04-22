package services

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// OpenResult is the return shape of OpenLocal (and, in later milestones,
// OpenRemote). Carries everything the frontend needs to navigate from
// the Welcome screen into the runbook view.
type OpenResult struct {
	// GruntbookPath is the resolved absolute path to gruntbook.mdx that
	// Gin is now serving.
	GruntbookPath string `json:"gruntbookPath"`
	// DisplayPath is what the UI should show in the header. For local
	// opens it's the on-disk path; for remote opens (future) it's the
	// original URL.
	DisplayPath string `json:"displayPath"`
	// Port is the localhost port Gin bound to. The desktop asset
	// handler proxies /api/* to this port, so the frontend doesn't
	// hard-code it — this is surfaced for logging/debug only.
	Port int `json:"port"`
}

// DesktopStatus is the initial-state snapshot the Welcome page reads
// on mount to decide whether to show itself or jump straight into the
// runbook view.
type DesktopStatus struct {
	// InitialPath was provided via `gruntbooks desktop PATH` and is
	// empty when the user launched the app with no argument.
	InitialPath string `json:"initialPath"`
	// GruntbookOpen is true once OpenLocal (or a pre-launch path) has
	// started the backend and a runbook is loaded.
	GruntbookOpen bool `json:"gruntbookOpen"`
	// ServerPort is the bound Gin port (0 if not running).
	ServerPort int `json:"serverPort"`
	// GruntbookPath mirrors OpenResult.GruntbookPath when a gruntbook
	// is open.
	GruntbookPath string `json:"gruntbookPath"`
}

// WelcomeService exposes the Welcome-screen actions (pick folder, open
// local, list recent) to the frontend over Wails IPC. All methods are
// safe for concurrent use.
//
// The service also holds the cross-cutting state the frontend needs on
// boot: whether a gruntbook was passed on the CLI, and whether the
// backend is running yet. That keeps the frontend from having to poll
// Gin's /api/health or guess about session readiness.
type WelcomeService struct {
	servers *serverManager
	recent  *recentStore
	// initialPath is set by cmd/desktop.go when the user invoked
	// `gruntbooks desktop PATH`. Empty means "no path, show Welcome".
	initialPath string
}

// NewWelcomeService builds a WelcomeService ready to be registered with
// application.NewService. initialPath may be empty.
func NewWelcomeService(initialPath string) (*WelcomeService, error) {
	recent, err := newRecentStore()
	if err != nil {
		return nil, fmt.Errorf("init recent store: %w", err)
	}
	return &WelcomeService{
		servers:     &serverManager{},
		recent:      recent,
		initialPath: initialPath,
	}, nil
}

// ServiceName satisfies the optional application.ServiceName interface
// so the Wails runtime logs this service with a friendly name.
func (s *WelcomeService) ServiceName() string {
	return "WelcomeService"
}

// Status returns the frontend's initial boot snapshot. Invariant: if
// GruntbookOpen is true, ServerPort is > 0.
func (s *WelcomeService) Status() DesktopStatus {
	cfg := s.servers.Config()
	port := s.servers.Port()
	return DesktopStatus{
		InitialPath:   s.initialPath,
		GruntbookOpen: port != 0,
		ServerPort:    port,
		GruntbookPath: cfg.GruntbookPath,
	}
}

// PickLocalFolder opens a native folder-picker and returns the selected
// absolute path, or an empty string if the user cancelled. Must run on
// the main thread — Wails handles that internally when invoked over
// IPC, but calling it from Go code should go through app.Dialog.
func (s *WelcomeService) PickLocalFolder() (string, error) {
	app := application.Get()
	if app == nil {
		return "", fmt.Errorf("desktop application not initialised")
	}
	path, err := app.Dialog.OpenFile().
		CanChooseFiles(false).
		CanChooseDirectories(true).
		SetTitle("Select a gruntbook folder").
		PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("open folder dialog: %w", err)
	}
	return path, nil
}

// OpenLocal validates a local path as a gruntbook, records it in the
// recent list, and starts the backend HTTP server for it. Safe to call
// at most once per desktop-app lifetime — calling twice with different
// paths returns an error. This matches M2's single-view, single-
// gruntbook model.
func (s *WelcomeService) OpenLocal(path string) (*OpenResult, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("path is required")
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve absolute path: %w", err)
	}

	gruntbookPath, err := api.ResolveGruntbookPath(abs)
	if err != nil {
		return nil, fmt.Errorf("no gruntbook found at %s: %w", abs, err)
	}

	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("resolve working directory: %w", err)
	}

	cfg := api.ServerConfig{
		GruntbookPath:         gruntbookPath,
		WorkingDir:            cwd,
		OutputPath:            "generated",
		UseExecutableRegistry: true,
		ReleaseMode:           true,
	}

	info, err := s.servers.Start(cfg)
	if err != nil {
		return nil, err
	}

	// Recent-list errors are non-fatal: the gruntbook is already open,
	// no point failing the call just because we couldn't persist state.
	if err := s.recordRecent(abs, gruntbookPath); err != nil {
		slog.Warn("Failed to record recent gruntbook", "path", abs, "error", err)
	}

	slog.Info("Opened gruntbook",
		"path", gruntbookPath,
		"workingDir", cwd,
		"port", info.Port)

	return &OpenResult{
		GruntbookPath: gruntbookPath,
		DisplayPath:   abs,
		Port:          info.Port,
	}, nil
}

// ListRecent returns the recent-gruntbooks list, most-recent-first.
// Entries whose path no longer exists on disk are still returned — the
// UI is responsible for showing a "missing" indicator so the user can
// prune stale entries themselves (they may have unmounted a volume).
func (s *WelcomeService) ListRecent() []RecentEntry {
	return s.recent.list()
}

// recordRecent turns a successful OpenLocal into a recent-list entry.
// inputPath is the user-provided path (typically the gruntbook
// directory), while gruntbookPath is the resolved .mdx. The directory
// makes a better display name than the .mdx filename.
func (s *WelcomeService) recordRecent(inputPath, gruntbookPath string) error {
	displayName := filepath.Base(inputPath)
	if displayName == "" || displayName == "." || displayName == "/" {
		// Fall back to the gruntbook file's parent when the input was a
		// root-ish path.
		displayName = filepath.Base(filepath.Dir(gruntbookPath))
	}
	return s.recent.record(RecentEntry{
		Path:        inputPath,
		DisplayName: displayName,
		IsRemote:    false,
		LastOpened:  time.Now(),
	})
}

// HandleSecondInstance is the Wails OnSecondInstanceLaunch callback.
// M2 policy: ignore the second invocation's args (we can't swap out a
// running Gin server) and bring the existing window forward. Exported
// so desktop.Run can wire it directly into SingleInstanceOptions.
func (s *WelcomeService) HandleSecondInstance(data application.SecondInstanceData) {
	if len(data.Args) > 0 {
		slog.Info("Ignoring second instance invocation; another gruntbook is already open",
			"args", data.Args)
	}
	app := application.Get()
	if app == nil {
		return
	}
	if win := app.Window.Current(); win != nil {
		win.Focus()
	}
}
