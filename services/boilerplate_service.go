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

// Render materializes a disk-backed boilerplate template (resolved
// relative to the open gruntbook) into the configured output path,
// performing manifest-tracked cleanup of orphaned files. Mirrors the
// legacy POST /api/boilerplate/render handler.
func (s *BoilerplateService) Render(req api.RenderRequest) (*api.RenderResponse, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no active session")
	}
	return api.RenderBoilerplate(req, cfg.GruntbookPath, cfg.WorkingDir, cfg.OutputPath, sessions)
}

// RenderInline renders a set of template files supplied in the request
// body (no on-disk template needed). Used by <Template> preview and by
// <Inputs> components that synthesize templates from captured inputs.
// Mirrors the legacy POST /api/boilerplate/render-inline handler.
func (s *BoilerplateService) RenderInline(req api.RenderInlineRequest) (*api.RenderInlineResponse, error) {
	cfg := s.servers.Config()
	sessions := s.servers.Sessions()
	// RenderInline is legal with no open gruntbook for draft previews,
	// but GenerateFile or Target="worktree" paths need a session. The
	// core function handles that via resolveTargetOutputDir errors.
	return api.RenderBoilerplateInline(req, cfg.WorkingDir, cfg.OutputPath, sessions)
}
