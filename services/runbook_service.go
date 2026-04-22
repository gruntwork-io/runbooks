package services

import (
	"fmt"
	"log/slog"

	"github.com/gruntwork-io/runbooks/api"
)

// RunbookService is the Wails IPC wrapper around the /api/gruntbook and
// /api/gruntbook/executables HTTP endpoints. "Runbook" is the domain
// noun for the open content; the new app is named Gruntbooks but the
// runbook concept is unchanged, so the type keeps the noun.
//
// Both methods are read-only snapshots of the currently-open gruntbook
// sourced from serverManager.Config() / serverManager.Registry(). They
// return typed shapes (not map[string]any) so the Wails TS codegen
// renders concrete interfaces consumable by the existing frontend
// hooks without runtime shape-checking.
type RunbookService struct {
	servers *serverManager
}

// ServiceName satisfies application.ServiceName.
func (s *RunbookService) ServiceName() string { return "RunbookService" }

// GruntbookResult mirrors the JSON shape previously returned by
// GET /api/gruntbook. FileMetadata fields are inlined; gruntbook-
// specific flags follow. Pointer/omitempty fields mirror the HTTP
// handler's conditional emissions so the frontend's existing
// GetFileReturn TS type lines up without rework.
type GruntbookResult struct {
	Path                  string   `json:"path"`
	Content               string   `json:"content"`
	ContentHash           string   `json:"contentHash"`
	Language              string   `json:"language"`
	Size                  int64    `json:"size"`
	UseExecutableRegistry bool     `json:"useExecutableRegistry"`
	IsWatchMode           bool     `json:"isWatchMode,omitempty"`
	RemoteSource          string   `json:"remoteSource,omitempty"`
	Warnings              []string `json:"warnings,omitempty"`
}

// ExecutablesResult mirrors the JSON shape previously returned by
// GET /api/gruntbook/executables. Live-reload mode (no registry)
// returns an empty map + empty warnings rather than an error, matching
// the HTTP handler behavior.
type ExecutablesResult struct {
	Executables map[string]*api.Executable `json:"executables"`
	Warnings    []string                   `json:"warnings"`
}

// Gruntbook returns the currently-open gruntbook's content and flags.
// Errors when no gruntbook is open (user is still on Welcome) since
// the frontend never asks for this before OpenLocal/OpenRemote returns.
func (s *RunbookService) Gruntbook() (*GruntbookResult, error) {
	cfg := s.servers.Config()
	if cfg.GruntbookPath == "" {
		return nil, fmt.Errorf("no gruntbook is open")
	}

	resolved, err := api.ResolveGruntbookPath(cfg.GruntbookPath)
	if err != nil {
		return nil, fmt.Errorf("resolve gruntbook path: %w", err)
	}

	meta, err := api.ReadFileMetadata(resolved)
	if err != nil {
		return nil, fmt.Errorf("read gruntbook: %w", err)
	}

	result := &GruntbookResult{
		Path:                  meta.Path,
		Content:               meta.Content,
		ContentHash:           meta.ContentHash,
		Language:              meta.Language,
		Size:                  meta.Size,
		UseExecutableRegistry: cfg.UseExecutableRegistry,
		IsWatchMode:           cfg.IsWatchMode,
		RemoteSource:          cfg.RemoteSourceURL,
	}

	// Live-reload: no registry, so validate for duplicate components
	// on demand. Registry mode captured warnings once at Start.
	if !cfg.UseExecutableRegistry {
		warnings, err := api.ValidateGruntbook(resolved)
		if err != nil {
			slog.Warn("gruntbook validation failed", "error", err)
		} else {
			result.Warnings = warnings
		}
	}

	return result, nil
}

// Executables returns the executable registry for the currently-open
// gruntbook. Live-reload mode (no registry) returns an empty map
// matching the HTTP handler's behavior.
func (s *RunbookService) Executables() (*ExecutablesResult, error) {
	registry, err := s.servers.Registry()
	if err != nil {
		return nil, err
	}
	if registry == nil {
		return &ExecutablesResult{
			Executables: map[string]*api.Executable{},
			Warnings:    []string{},
		}, nil
	}
	return &ExecutablesResult{
		Executables: registry.GetAllExecutables(),
		Warnings:    registry.GetWarnings(),
	}, nil
}
