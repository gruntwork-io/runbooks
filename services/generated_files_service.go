package services

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/api"
)

// GeneratedFilesService exposes the output-directory inspection and
// clear-all operations to the frontend over Wails IPC. It mirrors
// GET /api/generated-files/check and DELETE /api/generated-files/delete.
//
// Path resolution uses the currently-open gruntbook's WorkingDir +
// OutputPath, so a call made while no gruntbook is open is a logic
// error from the caller and fails fast.
type GeneratedFilesService struct {
	servers *serverManager
}

// ServiceName satisfies the optional application.ServiceName interface.
func (s *GeneratedFilesService) ServiceName() string {
	return "GeneratedFilesService"
}

// Check returns info about the output directory: whether it exists,
// how many files it contains, and the absolute path it resolved to.
func (s *GeneratedFilesService) Check() (*api.GeneratedFilesCheckResponse, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	return api.CheckGeneratedFiles(cfg.WorkingDir, cfg.OutputPath)
}

// Delete removes every file and subdirectory inside the output
// directory, but preserves the directory itself (for downstream
// watchers/IDE trees). A non-existent directory is treated as a
// successful no-op.
func (s *GeneratedFilesService) Delete() (*api.GeneratedFilesDeleteResponse, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	return api.DeleteGeneratedFiles(cfg.WorkingDir, cfg.OutputPath)
}
