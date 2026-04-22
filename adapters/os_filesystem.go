package adapters

import (
	"io/fs"
	"os"
	"path/filepath"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// OsFileSystem implements ports.FileSystem using the host filesystem.
type OsFileSystem struct{}

// NewOsFileSystem returns a FileSystem backed by the host filesystem.
func NewOsFileSystem() *OsFileSystem {
	return &OsFileSystem{}
}

func (f *OsFileSystem) Read(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (f *OsFileSystem) Write(path string, data []byte, perm fs.FileMode) error {
	return os.WriteFile(path, data, perm)
}

func (f *OsFileSystem) Stat(path string) (fs.FileInfo, error) {
	return os.Stat(path)
}

func (f *OsFileSystem) ReadDir(path string) ([]fs.DirEntry, error) {
	return os.ReadDir(path)
}

func (f *OsFileSystem) MkdirAll(path string, perm fs.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (f *OsFileSystem) Remove(path string) error {
	return os.Remove(path)
}

func (f *OsFileSystem) RemoveAll(path string) error {
	return os.RemoveAll(path)
}

func (f *OsFileSystem) WalkDir(root string, fn fs.WalkDirFunc) error {
	return filepath.WalkDir(root, fn)
}

// Compile-time check that OsFileSystem implements the port.
var _ ports.FileSystem = (*OsFileSystem)(nil)
