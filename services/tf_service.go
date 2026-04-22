package services

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/api"
)

// TfService exposes OpenTofu/Terraform module parsing to the frontend
// over Wails IPC. It mirrors the legacy `POST /api/tf/parse` handler.
//
// A fresh TokenResolver is built per call so env/auth-helper changes
// after the app launched (e.g. the user ran `gh auth login` in a new
// terminal) are picked up immediately, matching the HTTP path.
type TfService struct {
	servers *serverManager
}

// ServiceName satisfies the optional application.ServiceName interface.
func (s *TfService) ServiceName() string {
	return "TfService"
}

// Parse resolves a module source (local path relative to the open
// gruntbook, or a remote git URL) and returns the boilerplate-shaped
// variables plus module metadata.
func (s *TfService) Parse(req api.TfParseRequest) (*api.TfParseResponse, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	tokens := api.NewTokenResolver(adapters.NewOsEnvironment(), adapters.NewOsProcessSpawner())
	return api.ParseTfModuleRequest(req, cfg.GruntbookPath, tokens)
}
