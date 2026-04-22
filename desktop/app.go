// Package desktop boots the Wails v3 window that hosts the Gruntbooks
// React UI. This is an M1 hello-world: the window renders the existing
// embedded SPA so we can confirm React 19 + MDX + Tailwind survive the
// transport swap. Services and IPC bindings land in later milestones.
package desktop

import (
	"fmt"
	"io/fs"
	"net/http"
	"strings"

	"github.com/gruntwork-io/runbooks/web"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Options controls the Wails window that gets opened.
type Options struct {
	// Title is the window title (also the macOS app menu name in dev).
	Title string
	// Width and Height are the initial window dimensions in pixels.
	Width  int
	Height int
}

// Run boots Wails, serves the embedded React bundle from web/dist, and
// opens a single window. Blocks until the window is closed. Returns any
// error from the Wails runtime; callers typically log.Fatal on failure.
func Run(opts Options) error {
	handler, err := assetHandler()
	if err != nil {
		return fmt.Errorf("build asset handler: %w", err)
	}

	app := application.New(application.Options{
		Name:        "Gruntbooks",
		Description: "Gruntbooks desktop",
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
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

// assetHandler returns an http.Handler that serves the embedded
// web/dist tree, falling back to index.html for anything that doesn't
// resolve to a real file. The fallback is what makes SPA client-side
// routing work: /some/deep/path 404s on disk, but we hand back the
// shell and let React Router resolve it.
func assetHandler() (http.Handler, error) {
	distFS, err := web.GetDistFS()
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(distFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			fileServer.ServeHTTP(w, r)
			return
		}
		if f, err := distFS.Open(path); err == nil {
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
