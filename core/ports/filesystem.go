package ports

import "io/fs"

// FileSystem abstracts filesystem access for domain code.
//
// Paths are interpreted by the adapter. The desktop adapter treats them
// as absolute or relative paths on the host filesystem. A hosted adapter
// could confine all paths to a per-tenant root directory, rejecting
// path traversal attempts before they reach the host.
//
// This port uses io/fs types (FileInfo, DirEntry, FileMode, WalkDirFunc)
// so the ports package itself imports nothing from os.
type FileSystem interface {
	// Read returns the contents of the file at path.
	Read(path string) ([]byte, error)

	// Write writes data to the file at path, creating it (with perm) if
	// it doesn't exist or truncating it if it does.
	Write(path string, data []byte, perm fs.FileMode) error

	// Stat returns file info for the given path.
	Stat(path string) (fs.FileInfo, error)

	// ReadDir returns the entries in the directory at path, sorted by
	// filename.
	ReadDir(path string) ([]fs.DirEntry, error)

	// MkdirAll creates the directory at path along with any necessary
	// parents. Returns nil if the directory already exists.
	MkdirAll(path string, perm fs.FileMode) error

	// Remove removes the file or empty directory at path.
	Remove(path string) error

	// RemoveAll removes path and any children it contains. Returns nil
	// if the path does not exist.
	RemoveAll(path string) error

	// WalkDir walks the file tree rooted at root, calling fn for each
	// file or directory. The walk follows the io/fs.WalkDir contract.
	WalkDir(root string, fn fs.WalkDirFunc) error
}
