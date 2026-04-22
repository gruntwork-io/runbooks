package services

import (
	"github.com/gruntwork-io/runbooks/api"
)

// WorkspaceService exposes the read-only workspace introspection
// endpoints to the frontend over Wails IPC. These are used by the
// Workspace, RepositoryFileBrowser, ChangedFilesView, DirPicker and
// GitHubPullRequest components.
//
// Stateful actions (register/set-active worktree) stay on the HTTP
// path through M3 because they mutate SessionManager; they'll move
// over in M4 alongside the exec migration.
type WorkspaceService struct{}

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
