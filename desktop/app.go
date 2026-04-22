// Package desktop boots the Wails v3 window that hosts the Gruntbooks
// React UI.
//
// M2 scope: register the WelcomeService over IPC, serve the embedded
// SPA, and proxy /api/* requests to the embedded Gin server once it
// starts. Later milestones (M3/M4) migrate the remaining HTTP
// endpoints to IPC services and remove the proxy.
package desktop

import (
	_ "embed"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/gruntwork-io/runbooks/services"
	"github.com/gruntwork-io/runbooks/web"
	"github.com/wailsapp/wails/v3/pkg/application"
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
}

// Run boots Wails, registers the IPC services, serves the embedded
// React bundle (proxying /api/* to the embedded Gin server once it's
// running), and opens a single window. Blocks until the window is
// closed. Returns any error from the Wails runtime; callers typically
// log.Fatal on failure.
func Run(opts Options) error {
	svcs, err := services.NewServices(opts.InitialPath)
	if err != nil {
		return fmt.Errorf("build services: %w", err)
	}

	handler, err := assetHandler(svcs.Welcome)
	if err != nil {
		return fmt.Errorf("build asset handler: %w", err)
	}

	app := application.New(application.Options{
		Name:        "Gruntbooks",
		Description: "Gruntbooks desktop",
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
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               "io.gruntwork.gruntbooks",
			OnSecondInstanceLaunch: svcs.Welcome.HandleSecondInstance,
		},
		Assets: application.AssetOptions{
			Handler: handler,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  opts.Title,
		Width:  opts.Width,
		Height: opts.Height,
		URL:    "/",
	})

	return app.Run()
}

// assetHandler returns an http.Handler that:
//   - Proxies /api/* requests to the embedded Gin server on whatever
//     localhost port WelcomeService has started it on. Same-origin
//     proxying means the frontend doesn't have to care about ports,
//     CORS, or token scoping.
//   - Serves the embedded web/dist tree for everything else, falling
//     back to index.html for anything that doesn't resolve to a real
//     file (SPA client-side routing).
//
// The proxy looks up the current Gin port on every request rather than
// capturing it once, so a late-starting backend (Welcome → OpenLocal)
// transparently starts handling requests as soon as Gin binds.
func assetHandler(welcome *services.WelcomeService) (http.Handler, error) {
	distFS, err := web.GetDistFS()
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(distFS))
	apiProxy := newAPIProxy(welcome)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if strings.HasPrefix(path, "/api/") {
			apiProxy.ServeHTTP(w, r)
			return
		}

		trimmed := strings.TrimPrefix(path, "/")
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

// newAPIProxy returns an http.Handler that reverse-proxies API calls
// to Gin. If Gin isn't running yet (user is still on the Welcome
// screen), it returns 503 rather than trying to contact a phantom
// upstream.
func newAPIProxy(welcome *services.WelcomeService) http.Handler {
	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			port := welcome.Status().ServerPort
			if port == 0 {
				// Director can't fail cleanly; leaving the URL alone
				// causes httputil to surface a "no Host in request URL"
				// error. The wrapper below checks the port first.
				return
			}
			target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
		},
		// Flush immediately so SSE (watch mode, exec streaming, etc.)
		// works through the proxy.
		FlushInterval: -1,
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if welcome.Status().ServerPort == 0 {
			http.Error(w, "gruntbook server not running", http.StatusServiceUnavailable)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, distFS fs.FS) {
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	http.FileServer(http.FS(distFS)).ServeHTTP(w, r2)
}
