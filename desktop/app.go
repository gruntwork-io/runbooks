// Package desktop boots the Wails v3 window that hosts the Gruntbooks
// React UI.
//
// Post-M5.5 scope: register every IPC service, serve the embedded SPA
// for asset requests, and open one window. The desktop binary binds no
// TCP listener — the previous /api/* reverse proxy to an embedded Gin
// server has been removed; every frontend operation is a Wails IPC
// call against a service in services/.
package desktop

import (
	"context"
	_ "embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"runtime"
	"strings"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/services"
	"github.com/gruntwork-io/runbooks/web"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// iconPNG is the 1024x1024 Gruntbooks logomark. Wails passes this to
// NSApplication.setApplicationIconImage on macOS, which updates the
// Dock and Cmd+Tab switcher at runtime. Without this, bare binaries
// (no .app bundle) show the default executable icon. Regenerate with
// `task desktop:icon:gen` if the logo changes.
//
//go:embed assets/icon.png
var iconPNG []byte

// Options controls the Wails window that gets opened.
type Options struct {
	// Title is the window title (also the macOS app menu name in dev).
	Title string
	// Width and Height are the initial window dimensions in pixels.
	Width  int
	Height int
	// InitialPath is the gruntbook path passed on the CLI via
	// `gruntbooks desktop PATH`. Empty means the user wants to see the
	// Welcome screen and pick a gruntbook interactively.
	InitialPath string
	// IsAuthorMode is the boot-time Author Mode toggle, set by
	// `gruntbooks watch` (true) and `gruntbooks open` (false). The user
	// can flip it at runtime via the View menu.
	IsAuthorMode bool
	// Version is the build-stamped cmd.Version, threaded through to
	// UpdateService so its "latest release" comparison has something
	// to work with. Dev builds pass "dev" (or empty) and UpdateService
	// skips polling.
	Version string
}

// Run boots Wails, registers the IPC services, serves the embedded
// React bundle, and opens a single window. Blocks until the window is
// closed. Returns any error from the Wails runtime; callers typically
// log.Fatal on failure.
func Run(opts Options) error {
	svcs, err := services.NewServices(opts.InitialPath, opts.IsAuthorMode, adapters.NewWailsEmitter(), opts.Version)
	if err != nil {
		return fmt.Errorf("build services: %w", err)
	}

	// updateCtx controls the background update-check poll. Cancelled
	// when Run returns (window closed) so the goroutine doesn't leak
	// across dev-mode restarts.
	updateCtx, cancelUpdateCheck := context.WithCancel(context.Background())
	defer cancelUpdateCheck()
	go services.RunAutoCheck(updateCtx, svcs.Update)

	handler, err := assetHandler()
	if err != nil {
		return fmt.Errorf("build asset handler: %w", err)
	}

	app := application.New(application.Options{
		Name:        "Gruntbooks",
		Description: "Gruntbooks by Gruntwork\n\nInteractive runbooks for DevOps subject-matter experts.",
		Icon:        iconPNG,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Services: []application.Service{
			application.NewService(svcs.Welcome),
			application.NewService(svcs.Telemetry),
			application.NewService(svcs.File),
			application.NewService(svcs.Boilerplate),
			application.NewService(svcs.Tf),
			application.NewService(svcs.GeneratedFiles),
			application.NewService(svcs.Workspace),
			application.NewService(svcs.Exec),
			application.NewService(svcs.Aws),
			application.NewService(svcs.GitHub),
			application.NewService(svcs.Git),
			application.NewService(svcs.Watcher),
			application.NewService(svcs.Session),
			application.NewService(svcs.Runbook),
			application.NewService(svcs.Update),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               "io.gruntwork.gruntbooks",
			OnSecondInstanceLaunch: svcs.Welcome.HandleSecondInstance,
		},
		Assets: application.AssetOptions{
			Handler: handler,
		},
	})

	win := app.Window.NewWithOptions(buildWindowOptions(opts))

	// EnableFileDrop forwards external file drops onto elements with the
	// `data-file-drop-target` attribute. Re-emit as a custom event so the
	// Welcome page can react without taking a hard dependency on Wails'
	// internal event names.
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(ev *application.WindowEvent) {
		files := ev.Context().DroppedFiles()
		if len(files) == 0 {
			return
		}
		application.Get().Event.Emit("welcome:files-dropped", map[string]any{
			"files": files,
		})
	})

	installAppMenu(app)

	return app.Run()
}

// buildWindowOptions returns the WebviewWindowOptions for the main
// window. Split out so the macOS-specific frameless title bar config
// stays readable. EnableFileDrop is enabled on every platform so the
// Welcome page can accept drag-drop opens.
func buildWindowOptions(opts Options) application.WebviewWindowOptions {
	wopts := application.WebviewWindowOptions{
		Title:          opts.Title,
		Width:          opts.Width,
		Height:         opts.Height,
		MinWidth:       500,
		MinHeight:      400,
		URL:            "/",
		EnableFileDrop: true,
	}
	if runtime.GOOS == "darwin" {
		// MacTitleBarHiddenInsetUnified hides the system title bar but
		// keeps the traffic-light buttons inset, integrated with our own
		// header chrome. InvisibleTitleBarHeight defines a transparent
		// drag region above the React content so users can grab the
		// window by its top edge even when our header has interactive
		// controls beneath it. Height matches the Header's min-h-16
		// (4rem) so the entire header band acts as a drag handle except
		// where buttons opt out via `--wails-draggable: no-drag`.
		wopts.Mac = application.MacWindow{
			TitleBar:                application.MacTitleBarHiddenInsetUnified,
			InvisibleTitleBarHeight: 64,
		}
	}
	return wopts
}

// installAppMenu replaces the default application menu so the macOS
// "About Gruntbooks" item routes through Wails' ShowAbout (an NSAlert
// seeded with our embedded icon + description) rather than the
// native orderFrontStandardAboutPanel: selector, which reads
// Info.plist and shows a generic folder icon when run as a bare
// binary. The View menu also gets an Author Mode toggle that emits
// `author-mode:toggle` so the React layer can react without needing
// IPC plumbing for what is effectively a UI-only setting.
func installAppMenu(app *application.App) {
	if runtime.GOOS != "darwin" {
		return
	}

	menu := app.NewMenu()

	appSubmenu := menu.AddSubmenu("Gruntbooks")
	appSubmenu.Add("About Gruntbooks").OnClick(func(_ *application.Context) {
		showAboutDialog(app)
	})
	appSubmenu.AddSeparator()
	appSubmenu.AddRole(application.ServicesMenu)
	appSubmenu.AddSeparator()
	appSubmenu.AddRole(application.Hide)
	appSubmenu.AddRole(application.HideOthers)
	appSubmenu.AddRole(application.UnHide)
	appSubmenu.AddSeparator()
	appSubmenu.AddRole(application.Quit)

	menu.AddRole(application.FileMenu)
	menu.AddRole(application.EditMenu)

	viewSubmenu := menu.AddSubmenu("View")
	viewSubmenu.Add("Toggle Author Mode").
		SetAccelerator("CmdOrCtrl+Shift+A").
		OnClick(func(_ *application.Context) {
			if !app.Event.Emit("author-mode:toggle") {
				slog.Warn("No subscribers for author-mode:toggle event")
			}
		})
	viewSubmenu.AddSeparator()
	viewSubmenu.AddRole(application.Reload)
	viewSubmenu.AddRole(application.ToggleFullscreen)
	viewSubmenu.AddSeparator()
	viewSubmenu.AddRole(application.ResetZoom)
	viewSubmenu.AddRole(application.ZoomIn)
	viewSubmenu.AddRole(application.ZoomOut)

	menu.AddRole(application.WindowMenu)
	menu.AddRole(application.HelpMenu)

	app.Menu.SetApplicationMenu(menu)
}

// showAboutDialog opens an NSAlert-based About panel with our embedded
// icon and buttons that deep-link to the docs site and the GitHub repo.
// Using the MessageDialog API (rather than app.Menu.ShowAbout) gives us
// control over buttons so users have a one-click path to both resources.
// NSAlert dismisses on any button press — that's expected, native About
// panels typically only have a single action.
func showAboutDialog(app *application.App) {
	dialog := app.Dialog.Info()
	dialog.SetTitle("Gruntbooks")
	dialog.SetMessage("Gruntbooks by Gruntwork\n\nInteractive runbooks for DevOps subject-matter experts.")
	dialog.SetIcon(iconPNG)
	// NSAlert renders buttons right-to-left in the order added to the
	// underlying list's reverse — Wails' macOS dialog impl reverses
	// before calling addButtonWithTitle:, so the LAST AddButton call
	// ends up rightmost. We want OK rightmost (default).
	dialog.AddButton("Documentation").OnClick(func() {
		_ = app.Browser.OpenURL("https://gruntbooks.gruntwork.io")
	})
	dialog.AddButton("View on GitHub").OnClick(func() {
		_ = app.Browser.OpenURL("https://github.com/gruntwork-io/gruntbooks")
	})
	dialog.AddButton("OK").SetAsDefault()
	dialog.Show()
}

// assetHandler returns an http.Handler that serves the embedded
// web/dist tree, falling back to index.html for routes that don't
// resolve to a real file (SPA client-side routing). Wails uses this
// handler internally to satisfy webview asset requests; it is not
// bound to any TCP socket.
func assetHandler() (http.Handler, error) {
	distFS, err := web.GetDistFS()
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(distFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trimmed := strings.TrimPrefix(r.URL.Path, "/")
		if trimmed == "" {
			fileServer.ServeHTTP(w, r)
			return
		}
		if f, err := distFS.Open(trimmed); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		serveIndex(w, r, distFS)
	}), nil
}

func serveIndex(w http.ResponseWriter, r *http.Request, distFS fs.FS) {
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	http.FileServer(http.FS(distFS)).ServeHTTP(w, r2)
}
