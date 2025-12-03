package web

import (
	"embed"
	"io/fs"
)

//go:embed dist/*
var distFS embed.FS

// GetDistFS returns a filesystem rooted at the dist directory.
// This strips the "dist" prefix so files can be accessed directly.
func GetDistFS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}

// GetAssetsFS returns a filesystem rooted at the dist/assets directory.
// This is useful for serving the /assets route.
func GetAssetsFS() (fs.FS, error) {
	return fs.Sub(distFS, "dist/assets")
}

