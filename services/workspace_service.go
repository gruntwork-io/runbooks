package services

import (
	"fmt"

	"github.com/gruntwork-io/runbooks/api"
)

// WorkspaceService exposes workspace introspection + worktree
// registration to the frontend over Wails IPC. Read-only methods
// (Tree, Dirs, File, Changes) are session-agnostic and take only a
// path; mutating methods (Register, SetActive) require a session
// token so they match the HTTP path's SessionAuthMiddleware
// semantics.
type WorkspaceService struct {
	servers *serverManager
}

// ServiceName satisfies the optional application.ServiceName interface.
func (s *WorkspaceService) ServiceName() string {
	return "WorkspaceService"
}

// Tree returns the structure-only file tree (plus git metadata) for
// an absolute workspace path. Callers must pass an absolute path —
// frontend worktrees always have localPath populated.
func (s *WorkspaceService) Tree(absPath string) (*api.WorkspaceTreeResponse, error) {
	return api.GetWorkspaceTree(absPath)
}

// Dirs returns the immediate, non-hidden subdirectory names of an
// absolute path. Used by the DirPicker cascading dropdown.
func (s *WorkspaceService) Dirs(absPath string) ([]string, error) {
	return api.GetWorkspaceDirs(absPath)
}

// File returns the contents of a single workspace file (absolute
// path), with metadata flags for images/binaries/oversize files.
func (s *WorkspaceService) File(absPath string) (*api.WorkspaceFileResponse, error) {
	return api.GetWorkspaceFile(absPath)
}

// Changes returns git change metadata for a worktree. Pass a
// non-empty singleFile to get only that file's diff; pass "" for the
// bulk changeset. Exceeds maxChangedFiles → TooManyChanges flag.
func (s *WorkspaceService) Changes(absPath, singleFile string) (*api.WorkspaceChangesResponse, error) {
	return api.GetWorkspaceChanges(absPath, singleFile)
}

// Register adds a worktree path to the session's registered worktree
// list. Matches POST /api/workspace/register — used by
// GitWorkTreeContext when a clone completes or a worktree is discovered
// on session bootstrap.
func (s *WorkspaceService) Register(sessionID, path string) error {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("path is required")
	}
	sessions.RegisterWorkTreePath(path)
	return nil
}

// SetActive sets the explicitly selected active worktree path.
// Matches POST /api/workspace/set-active — used when the user
// switches worktrees in the UI so that target="worktree" templates
// and REPO_FILES resolve against the selected repo.
func (s *WorkspaceService) SetActive(sessionID, path string) error {
	sessions, err := s.authed(sessionID)
	if err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("path is required")
	}
	sessions.SetActiveWorkTreePath(path)
	return nil
}

// authed mirrors SessionService.authed: resolve the gruntbook's
// SessionManager and verify the caller's token before any mutation.
func (s *WorkspaceService) authed(sessionID string) (*api.SessionManager, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	if sessionID == "" {
		return nil, fmt.Errorf("missing session token")
	}
	if _, ok := sessions.ValidateToken(sessionID); !ok {
		return nil, fmt.Errorf("invalid or expired session token")
	}
	return sessions, nil
}
