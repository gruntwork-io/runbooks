package services

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/gruntwork-io/runbooks/api"
)

// FileService exposes reads of the currently-open gruntbook and files
// under its directory to the frontend over IPC.
//
// Semantics mirror the `POST /api/file` HTTP handler: an empty
// RelativePath returns the gruntbook.mdx itself; a relative path is
// resolved against filepath.Dir(gruntbookPath). Reads outside the
// gruntbook directory are refused.
type FileService struct {
	servers *serverManager
}

// ServiceName is the friendly name shown in Wails runtime logs.
func (s *FileService) ServiceName() string {
	return "FileService"
}

// FileResult is the IPC response shape for Read. Field names are
// camelCase to match the HTTP handler's JSON output so the browser
// fallback and the IPC path return the same thing to the frontend.
type FileResult struct {
	Path        string `json:"path"`
	Content     string `json:"content"`
	ContentHash string `json:"contentHash"`
	Language    string `json:"language"`
	Size        int64  `json:"size"`
}

// Read returns a file from the currently-open gruntbook's directory.
// An empty relPath returns the gruntbook.mdx itself. relPath must stay
// inside the gruntbook directory; ".." escapes are rejected.
func (s *FileService) Read(relPath string) (*FileResult, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}

	filePath := cfg.GruntbookPath
	if relPath != "" {
		baseDir := filepath.Dir(cfg.GruntbookPath)
		cleaned := filepath.Clean(filepath.Join(baseDir, relPath))
		rel, err := filepath.Rel(baseDir, cleaned)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("path %q is outside the gruntbook directory", relPath)
		}
		filePath = cleaned
	}

	meta, err := api.ReadFileMetadata(filePath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filePath, err)
	}

	return &FileResult{
		Path:        meta.Path,
		Content:     meta.Content,
		ContentHash: meta.ContentHash,
		Language:    meta.Language,
		Size:        meta.Size,
	}, nil
}
