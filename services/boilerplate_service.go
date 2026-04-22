package services

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/api"
)

// BoilerplateService exposes the boilerplate.yml parser used by the
// <Inputs> and <Template> blocks. Today this is read-only: the frontend
// asks for variables + output-dependency metadata and renders a form.
//
// Semantics mirror the legacy `POST /api/boilerplate/variables` handler
// (see api.HandleBoilerplateRequest) so the migrated frontend hook
// doesn't observe a behavior change when the transport switches.
type BoilerplateService struct {
	servers *serverManager
}

// ServiceName satisfies the optional application.ServiceName interface.
func (s *BoilerplateService) ServiceName() string {
	return "BoilerplateService"
}

// ParseVariables parses a boilerplate.yml — either one referenced by
// templatePath (resolved relative to the open gruntbook) or inline
// boilerplateContent — and returns the variable declarations.
func (s *BoilerplateService) ParseVariables(req api.BoilerplateRequest) (*api.BoilerplateConfig, error) {
	cfg := s.servers.Config()
	// An inline boilerplateContent request is legal with no open
	// gruntbook (the frontend uses it for <Template> preview on draft
	// content); only reject when a templatePath is given.
	if req.TemplatePath != "" && cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	return api.ParseBoilerplateRequest(req, cfg.GruntbookPath)
}
