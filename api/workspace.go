package api

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Types
// =============================================================================

// WorkspaceTreeNode represents a file or folder in the workspace tree (structure only, no content).
type WorkspaceTreeNode struct {
	// ID is the unique identifier for this node, typically the file path relative to the workspace root.
	ID string `json:"id"`
	// Name is the display name of the file or folder (e.g., "main.go", "src").
	Name string `json:"name"`
	// Type is either "file" or "folder".
	Type string `json:"type"`
	// Size is the file size in bytes. Only set for files, omitted for folders.
	Size int64 `json:"size,omitempty"`
	// Language is the detected programming language of the file (e.g., "go", "typescript").
	Language string `json:"language,omitempty"`
	// IsBinary is true when the file is detected as a binary (non-text) file.
	IsBinary bool `json:"isBinary,omitempty"`
	// IsIgnored is true when the file or folder is matched by .gitignore rules.
	// The frontend renders these with muted styling to indicate they are not tracked by git.
	IsIgnored bool `json:"isIgnored,omitempty"`
	// IsLazyLoad is true for folders that contain too many entries to load upfront (>500 children).
	// The frontend shows a placeholder and fetches the subtree on demand when the user expands the folder.
	IsLazyLoad bool `json:"isLazyLoad,omitempty"`
	// Children contains the nested files and folders within this folder. Empty for files.
	Children []WorkspaceTreeNode `json:"children,omitempty"`
}

// WorkspaceGitInfo contains git metadata for a workspace.
type WorkspaceGitInfo struct {
	Ref       string `json:"ref"`
	RefType   string `json:"refType"` // "branch", "tag", or "commit"
	RemoteURL string `json:"remoteUrl"`
	CommitSha string `json:"commitSha"`
}

// WorkspaceTreeResponse is the response for GET /api/workspace/tree.
type WorkspaceTreeResponse struct {
	Tree       []WorkspaceTreeNode `json:"tree"`
	TotalFiles int                 `json:"totalFiles"`
	GitInfo    *WorkspaceGitInfo   `json:"gitInfo,omitempty"`
}

// WorkspaceFileResponse is the response for GET /api/workspace/file.
type WorkspaceFileResponse struct {
	Path     string `json:"path"`
	Content  string `json:"content,omitempty"`
	Language string `json:"language"`
	Size     int64  `json:"size"`
	IsImage  bool   `json:"isImage,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	DataUri  string `json:"dataUri,omitempty"`
	IsBinary bool   `json:"isBinary,omitempty"`
	IsTooLarge bool `json:"isTooLarge,omitempty"`
}

// WorkspaceFileChange represents a single file change in a git workspace.
type WorkspaceFileChange struct {
	Path            string `json:"path"`
	ChangeType      string `json:"changeType"` // "added", "modified", "deleted"
	Additions       int    `json:"additions"`
	Deletions       int    `json:"deletions"`
	OriginalContent string `json:"originalContent,omitempty"`
	NewContent      string `json:"newContent,omitempty"`
	Language        string `json:"language"`
	IsBinary        bool   `json:"isBinary,omitempty"`
	DiffTruncated   bool   `json:"diffTruncated,omitempty"`
}

// WorkspaceChangesResponse is the response for GET /api/workspace/changes.
type WorkspaceChangesResponse struct {
	Changes        []WorkspaceFileChange `json:"changes"`
	TotalChanges   int                   `json:"totalChanges"`
	TooManyChanges bool                  `json:"tooManyChanges,omitempty"`
}

// =============================================================================
// Constants
// =============================================================================

// Performance guardrails — var instead of const so tests can override with small values.
var (
	maxWorkspaceFiles  = 10000
	maxFileContentSize = int64(1 * 1024 * 1024) // 1 MB
	maxDiffSizePerFile = 50 * 1024               // 50 KB
	maxChangedFiles    = 500
	maxDirEntries      = 500
)

// imageExtensions maps file extensions to MIME types for images we render inline.
var imageExtensions = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
}

// binaryExtensions lists file extensions that are always binary (non-image).
var binaryExtensions = map[string]bool{
	".zip": true, ".tar": true, ".gz": true, ".bz2": true, ".xz": true, ".7z": true,
	".rar": true, ".jar": true, ".war": true, ".ear": true,
	".exe": true, ".dll": true, ".so": true, ".dylib": true,
	".bin": true, ".dat": true, ".o": true, ".a": true,
	".wasm": true, ".class": true, ".pyc": true, ".pyo": true,
	".ico": true, ".ttf": true, ".woff": true, ".woff2": true, ".eot": true, ".otf": true,
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".mp3": true, ".mp4": true, ".avi": true, ".mov": true, ".mkv": true, ".flv": true, ".wmv": true,
	".wav": true, ".flac": true, ".ogg": true, ".m4a": true,
}

// =============================================================================
// Pure functions (shared by HTTP + IPC paths)
// =============================================================================

// Sentinel errors surfaced by the pure workspace functions so callers
// can map them onto the appropriate transport response.
var (
	ErrWorkspacePathTraversal = fmt.Errorf("invalid path: directory traversal not allowed")
	ErrWorkspaceNotFound      = fmt.Errorf("path not found")
	ErrWorkspaceNotDir        = fmt.Errorf("path is not a directory")
	ErrWorkspaceIsDir         = fmt.Errorf("path is a directory, not a file")
	ErrWorkspaceTooManyFiles  = fmt.Errorf("too many files")
)

// statWorkspacePath validates a path string and stats it. Returns the
// info plus a sentinel error on missing / wrong-kind / traversal cases.
// Kind is "file" or "directory"; callers use it to pick the matching
// IsDir check.
func statWorkspacePath(path string) (os.FileInfo, error) {
	if ContainsPathTraversal(path) {
		return nil, ErrWorkspacePathTraversal
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, path)
		}
		return nil, fmt.Errorf("failed to stat path %s: %w", path, err)
	}
	return info, nil
}

// GetWorkspaceTree builds the structure-only file tree for a workspace
// directory, with git metadata attached when the directory is a repo.
func GetWorkspaceTree(dirPath string) (*WorkspaceTreeResponse, error) {
	info, err := statWorkspacePath(dirPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: %s", ErrWorkspaceNotDir, dirPath)
	}

	fileCount := 0
	tree, err := buildWorkspaceTree(dirPath, "", &fileCount)
	if err != nil {
		if strings.Contains(err.Error(), "too many files") {
			return nil, fmt.Errorf("%w: directory contains more than %s files", ErrWorkspaceTooManyFiles, formatWithCommas(maxWorkspaceFiles))
		}
		return nil, fmt.Errorf("failed to build file tree: %w", err)
	}
	return &WorkspaceTreeResponse{
		Tree:       tree,
		TotalFiles: fileCount,
		GitInfo:    getGitInfo(dirPath),
	}, nil
}

// GetWorkspaceDirs returns the immediate, non-hidden subdirectory names
// of a directory. Backs the DirPicker cascading-dropdown UI.
func GetWorkspaceDirs(dirPath string) ([]string, error) {
	info, err := statWorkspacePath(dirPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: %s", ErrWorkspaceNotDir, dirPath)
	}

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	dirs := []string{}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			dirs = append(dirs, entry.Name())
		}
	}
	sort.Strings(dirs)
	return dirs, nil
}

// GetWorkspaceFile returns the contents and metadata for a single
// file. Images come back as base64 data URIs, known-binary extensions
// and null-byte-bearing content come back flagged (no content), and
// files larger than maxFileContentSize come back with IsTooLarge set
// so the UI can render a "too large to preview" placeholder.
func GetWorkspaceFile(filePath string) (*WorkspaceFileResponse, error) {
	info, err := statWorkspacePath(filePath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: %s", ErrWorkspaceIsDir, filePath)
	}

	language := getLanguageFromExtension(filepath.Base(filePath))
	ext := strings.ToLower(filepath.Ext(filePath))

	if info.Size() > maxFileContentSize {
		return &WorkspaceFileResponse{
			Path:       filePath,
			Language:   language,
			Size:       info.Size(),
			IsTooLarge: true,
		}, nil
	}

	if mimeType, isImage := imageExtensions[ext]; isImage {
		content, err := os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("failed to read file: %w", err)
		}
		return &WorkspaceFileResponse{
			Path:     filePath,
			Language: language,
			Size:     info.Size(),
			IsImage:  true,
			MimeType: mimeType,
			DataUri:  fmt.Sprintf("data:%s;base64,%s", mimeType, base64.StdEncoding.EncodeToString(content)),
		}, nil
	}

	if binaryExtensions[ext] {
		return &WorkspaceFileResponse{
			Path:     filePath,
			Language: language,
			Size:     info.Size(),
			IsBinary: true,
		}, nil
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	if bytes.Contains(content[:min(len(content), 8192)], []byte{0}) {
		return &WorkspaceFileResponse{
			Path:     filePath,
			Language: language,
			Size:     info.Size(),
			IsBinary: true,
		}, nil
	}

	return &WorkspaceFileResponse{
		Path:     filePath,
		Content:  string(content),
		Language: language,
		Size:     info.Size(),
	}, nil
}

// GetWorkspaceChanges returns the list of changed files in a git
// workspace. When singleFile is non-empty, returns only the diff for
// that file (used by the file-click → diff-view flow); otherwise
// returns the full change set. Exceeding maxChangedFiles yields a
// lightweight TooManyChanges response so the UI can warn instead of
// pulling MB of diff text.
func GetWorkspaceChanges(dirPath, singleFile string) (*WorkspaceChangesResponse, error) {
	if ContainsPathTraversal(dirPath) {
		return nil, ErrWorkspacePathTraversal
	}

	if singleFile != "" {
		change, err := getSingleFileDiff(dirPath, singleFile)
		if err != nil {
			return nil, fmt.Errorf("failed to get diff: %w", err)
		}
		return &WorkspaceChangesResponse{
			Changes:      []WorkspaceFileChange{*change},
			TotalChanges: 1,
		}, nil
	}

	changes, err := getAllChanges(dirPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get changes: %w", err)
	}
	totalChanges := len(changes)
	if totalChanges > maxChangedFiles {
		return &WorkspaceChangesResponse{
			Changes:        nil,
			TotalChanges:   totalChanges,
			TooManyChanges: true,
		}, nil
	}
	return &WorkspaceChangesResponse{
		Changes:      changes,
		TotalChanges: totalChanges,
	}, nil
}

// workspaceErrorStatus maps the workspace sentinel errors to an HTTP
// status code and human-readable message. Used by the Gin handlers.
func workspaceErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ErrWorkspacePathTraversal):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrWorkspaceNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, ErrWorkspaceNotDir), errors.Is(err, ErrWorkspaceIsDir):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrWorkspaceTooManyFiles):
		return http.StatusRequestEntityTooLarge, err.Error()
	default:
		return http.StatusInternalServerError, err.Error()
	}
}

// =============================================================================
// Handlers
// =============================================================================

// HandleWorkspaceTree returns the structure-only file tree for a workspace directory.
// GET /api/workspace/tree?path=<abs_path>
func HandleWorkspaceTree() gin.HandlerFunc {
	return func(c *gin.Context) {
		dirPath, ok := requirePathQuery(c)
		if !ok {
			return
		}
		resp, err := GetWorkspaceTree(dirPath)
		if err != nil {
			status, msg := workspaceErrorStatus(err)
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

// HandleWorkspaceDirs returns only the immediate subdirectory names of a given path.
// Designed for lightweight cascading dropdown UIs (e.g., DirPicker).
// GET /api/workspace/dirs?path=<abs_path>
func HandleWorkspaceDirs() gin.HandlerFunc {
	return func(c *gin.Context) {
		dirPath, ok := requirePathQuery(c)
		if !ok {
			return
		}
		dirs, err := GetWorkspaceDirs(dirPath)
		if err != nil {
			status, msg := workspaceErrorStatus(err)
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, gin.H{"dirs": dirs})
	}
}

// HandleWorkspaceFile returns the content of a single file.
// GET /api/workspace/file?path=<abs_path>
func HandleWorkspaceFile() gin.HandlerFunc {
	return func(c *gin.Context) {
		filePath, ok := requirePathQuery(c)
		if !ok {
			return
		}
		resp, err := GetWorkspaceFile(filePath)
		if err != nil {
			status, msg := workspaceErrorStatus(err)
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

// HandleWorkspaceChanges returns the list of changed files in a git workspace.
// GET /api/workspace/changes?path=<abs_path>&file=<optional>
func HandleWorkspaceChanges() gin.HandlerFunc {
	return func(c *gin.Context) {
		dirPath, ok := requirePathQuery(c)
		if !ok {
			return
		}
		resp, err := GetWorkspaceChanges(dirPath, c.Query("file"))
		if err != nil {
			status, msg := workspaceErrorStatus(err)
			c.JSON(status, gin.H{"error": msg})
			return
		}
		c.JSON(http.StatusOK, resp)
	}
}

// HandleWorkspaceRegister registers a worktree path with the session.
// POST /api/workspace/register
func HandleWorkspaceRegister(sm *SessionManager) gin.HandlerFunc {
	return handleWorkspacePathAction(sm.RegisterWorkTreePath)
}

// HandleWorkspaceSetActive sets the active worktree path.
// Called when the user switches between worktrees in the UI so that
// target="worktree" templates and REPO_FILES point to the correct repo.
// POST /api/workspace/set-active
func HandleWorkspaceSetActive(sm *SessionManager) gin.HandlerFunc {
	return handleWorkspacePathAction(sm.SetActiveWorkTreePath)
}

// handleWorkspacePathAction creates a handler that reads a JSON body with a
// "path" field and passes it to the given action.
func handleWorkspacePathAction(action func(string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Path string `json:"path"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Path == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
			return
		}

		action(req.Path)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// textBasedImageExtensions are image formats that are actually text (e.g., SVG is XML).
// These should be treated as text for diffing even though they render as images.
var textBasedImageExtensions = map[string]bool{
	".svg": true,
}

// isBinaryExt returns true if the file extension indicates a binary (non-text) file.
func isBinaryExt(ext string) bool {
	if textBasedImageExtensions[ext] {
		return false
	}
	return binaryExtensions[ext] || imageExtensions[ext] != ""
}

// getGitField runs a git command and returns the trimmed output, or "" on error.
func getGitField(dirPath string, args ...string) string {
	if out, err := runGitCommand(dirPath, args...); err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

// =============================================================================
// Tree Building
// =============================================================================

// buildWorkspaceTree builds a structure-only file tree (no content).
// At each directory level it batch-checks entries against gitignore and
// skips recursion into directories that are either gitignored or have more
// than maxDirEntries immediate entries, marking them as lazy-loadable.
func buildWorkspaceTree(rootPath string, relativePath string, fileCount *int) ([]WorkspaceTreeNode, error) {
	fullPath := filepath.Join(rootPath, relativePath)

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory %s: %w", fullPath, err)
	}

	// Sort: directories first, then files, alphabetically
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})

	ignoredSet := checkIgnoredPaths(rootPath, relativePath, entries)

	var result []WorkspaceTreeNode

	for _, entry := range entries {
		name := entry.Name()

		if entry.IsDir() && (name == ".git" || name == ".svn" || name == ".hg") {
			continue
		}

		entryRelPath := filepath.Join(relativePath, name)
		isIgnored := ignoredSet[entryRelPath]

		if entry.IsDir() {
			if isIgnored || isDirLarge(filepath.Join(fullPath, name)) {
				result = append(result, WorkspaceTreeNode{
					ID:         entryRelPath,
					Name:       name,
					Type:       "folder",
					IsIgnored:  isIgnored,
					IsLazyLoad: true,
				})
				continue
			}

			children, err := buildWorkspaceTree(rootPath, entryRelPath, fileCount)
			if err != nil {
				return nil, err
			}
			result = append(result, WorkspaceTreeNode{
				ID:       entryRelPath,
				Name:     name,
				Type:     "folder",
				Children: children,
			})
		} else {
			*fileCount++
			if *fileCount > maxWorkspaceFiles {
				return nil, fmt.Errorf("too many files: exceeded limit of %d", maxWorkspaceFiles)
			}

			info, err := entry.Info()
			if err != nil {
				slog.Warn("Failed to get file info, skipping", "path", entryRelPath, "error", err)
				continue
			}

			ext := strings.ToLower(filepath.Ext(name))

			result = append(result, WorkspaceTreeNode{
				ID:        entryRelPath,
				Name:      name,
				Type:      "file",
				Size:      info.Size(),
				Language:  getLanguageFromExtension(name),
				IsBinary:  isBinaryExt(ext),
				IsIgnored: isIgnored,
			})
		}
	}

	return result, nil
}

// checkIgnoredPaths runs a single git check-ignore --stdin call for all
// entries in a directory and returns a set of ignored relative paths.
func checkIgnoredPaths(rootPath string, relativePath string, entries []os.DirEntry) map[string]bool {
	var paths []string
	for _, entry := range entries {
		relPath := filepath.Join(relativePath, entry.Name())
		if entry.IsDir() {
			paths = append(paths, relPath+"/")
		} else {
			paths = append(paths, relPath)
		}
	}

	if len(paths) == 0 {
		return nil
	}

	stdin := strings.Join(paths, "\n") + "\n"
	cmd := exec.Command("git", "check-ignore", "--stdin")
	cmd.Dir = rootPath
	cmd.Stdin = strings.NewReader(stdin)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil && stderr.Len() > 0 {
		slog.Debug("git check-ignore failed", "error", err, "stderr", stderr.String())
	}

	ignored := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n") {
		line = strings.TrimRight(line, "/")
		if line != "" {
			ignored[line] = true
		}
	}
	return ignored
}

// isDirLarge returns true if the directory has more than maxDirEntries
// immediate entries, indicating it should be lazy-loaded.
func isDirLarge(dirPath string) bool {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return false
	}
	return len(entries) > maxDirEntries
}

// =============================================================================
// Git Operations
// =============================================================================

// getGitInfo retrieves git metadata for a directory.
func getGitInfo(dirPath string) *WorkspaceGitInfo {
	abbrevRef := getGitField(dirPath, "rev-parse", "--abbrev-ref", "HEAD")
	commitSha := getGitField(dirPath, "rev-parse", "HEAD")
	remoteURL := getGitField(dirPath, "remote", "get-url", "origin")

	if abbrevRef == "" && remoteURL == "" && commitSha == "" {
		return nil
	}

	ref := abbrevRef
	refType := "branch"

	if abbrevRef == "HEAD" {
		// Detached HEAD: check if the commit is an exact tag match
		tagName := getGitField(dirPath, "describe", "--exact-match", "--tags", "HEAD")
		if tagName != "" {
			ref = tagName
			refType = "tag"
		} else {
			// Bare commit SHA (detached, not on a tag)
			ref = commitSha
			refType = "commit"
		}
	}

	return &WorkspaceGitInfo{
		Ref:       ref,
		RefType:   refType,
		RemoteURL: remoteURL,
		CommitSha: commitSha,
	}
}

// parseStatusLines parses git status porcelain output into individual status lines.
// Returns the total count and the parsed lines (each at least 4 characters).
func parseStatusLines(statusOutput string) []string {
	trimmed := strings.TrimRight(statusOutput, "\n\r ")
	if trimmed == "" {
		return nil
	}
	var valid []string
	for _, line := range strings.Split(trimmed, "\n") {
		if len(line) >= 4 {
			valid = append(valid, line)
		}
	}
	return valid
}

// getAllChanges returns all changed files in a git workspace with inline diffs.
// When the number of changed files exceeds maxChangedFiles, it returns only
// lightweight metadata (path, changeType, language) without reading file
// contents from disk—avoiding expensive I/O for massive changesets like
// npm install.
func getAllChanges(dirPath string) ([]WorkspaceFileChange, error) {
	// Run git status --porcelain with --untracked-files=all to list individual
	// untracked files rather than directory summaries (e.g. "docs/account.hcl"
	// instead of "docs/").
	statusOutput, err := runGitCommand(dirPath, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return nil, fmt.Errorf("git status failed: %w", err)
	}

	lines := parseStatusLines(statusOutput)
	if len(lines) == 0 {
		return nil, nil
	}

	var changes []WorkspaceFileChange

	// Short-circuit: when there are too many changes, build a lightweight
	// list without reading any file content from disk.  The handler will
	// set tooManyChanges=true and the frontend will show a summary banner.
	lightweight := len(lines) > maxChangedFiles

	for _, line := range lines {
		// Parse git status porcelain format: XY filename
		statusCode := line[:2]
		filePath := strings.TrimSpace(line[3:])

		// Handle renamed files (R  old -> new)
		if strings.Contains(filePath, " -> ") {
			parts := strings.SplitN(filePath, " -> ", 2)
			filePath = parts[1]
		}

		changeType := parseGitStatusCode(statusCode)
		ext := strings.ToLower(filepath.Ext(filePath))
		isBinary := isBinaryExt(ext)

		change := WorkspaceFileChange{
			Path:       filePath,
			ChangeType: changeType,
			Language:   getLanguageFromExtension(filePath),
			IsBinary:   isBinary,
		}

		// In lightweight mode, skip all file I/O — just collect metadata.
		if lightweight {
			changes = append(changes, change)
			continue
		}

		// Skip diff content for binary files
		if isBinary {
			changes = append(changes, change)
			continue
		}

		// Get diff content for this file
		if err := populateDiffContent(dirPath, &change); err != nil {
			slog.Warn("Failed to get diff content", "file", filePath, "error", err)
		}

		// Check if diff exceeds size threshold
		totalDiffSize := len(change.OriginalContent) + len(change.NewContent)
		if totalDiffSize > maxDiffSizePerFile {
			change.OriginalContent = ""
			change.NewContent = ""
			change.DiffTruncated = true
		}

		changes = append(changes, change)
	}

	return changes, nil
}

// getSingleFileDiff returns the full diff for a single file (no size limit).
func getSingleFileDiff(dirPath string, filePath string) (*WorkspaceFileChange, error) {
	// Validate file path doesn't contain traversal
	if ContainsPathTraversal(filePath) {
		return nil, fmt.Errorf("invalid file path: directory traversal not allowed")
	}

	// Get the change type from git status
	statusOutput, err := runGitCommand(dirPath, "status", "--porcelain", "--", filePath)
	if err != nil {
		return nil, fmt.Errorf("git status failed: %w", err)
	}

	changeType := "modified" // default
	statusLine := strings.TrimRight(statusOutput, "\n\r ")
	if len(statusLine) >= 2 {
		changeType = parseGitStatusCode(statusLine[:2])
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	change := &WorkspaceFileChange{
		Path:       filePath,
		ChangeType: changeType,
		Language:   getLanguageFromExtension(filePath),
		IsBinary:   isBinaryExt(ext),
	}

	if !change.IsBinary {
		if err := populateDiffContent(dirPath, change); err != nil {
			return nil, fmt.Errorf("failed to get diff content: %w", err)
		}
	}

	return change, nil
}

// populateDiffContent fills in the original/new content and line counts for a change.
func populateDiffContent(dirPath string, change *WorkspaceFileChange) error {
	absFilePath := filepath.Join(dirPath, change.Path)

	switch change.ChangeType {
	case "added":
		// New file: read current content
		content, err := os.ReadFile(absFilePath)
		if err != nil {
			return fmt.Errorf("failed to read added file: %w", err)
		}
		change.NewContent = string(content)
		change.Additions = countLines(change.NewContent)

	case "deleted":
		// Deleted file: get original from HEAD
		original, err := runGitCommand(dirPath, "show", "HEAD:"+change.Path)
		if err != nil {
			return fmt.Errorf("failed to get original content: %w", err)
		}
		change.OriginalContent = original
		change.Deletions = countLines(change.OriginalContent)

	case "modified":
		// Modified file: get both versions
		original, err := runGitCommand(dirPath, "show", "HEAD:"+change.Path)
		if err != nil {
			// File might be untracked/new — treat as added
			change.ChangeType = "added"
			content, readErr := os.ReadFile(absFilePath)
			if readErr != nil {
				return fmt.Errorf("failed to read file: %w", readErr)
			}
			change.NewContent = string(content)
			change.Additions = countLines(change.NewContent)
			return nil
		}
		change.OriginalContent = original

		current, err := os.ReadFile(absFilePath)
		if err != nil {
			return fmt.Errorf("failed to read current file: %w", err)
		}
		change.NewContent = string(current)

		// Count additions/deletions from git diff --stat
		statOutput, err := runGitCommand(dirPath, "diff", "--numstat", "--", change.Path)
		if err == nil {
			parts := strings.Fields(strings.TrimSpace(statOutput))
			if len(parts) >= 2 {
				change.Additions, _ = strconv.Atoi(parts[0])
				change.Deletions, _ = strconv.Atoi(parts[1])
			}
		}
	}

	return nil
}

// parseGitStatusCode converts a git status porcelain code to a change type.
// Always returns a non-empty string ("added", "deleted", or "modified").
func parseGitStatusCode(code string) string {
	// Index status is code[0], working tree status is code[1]
	x := code[0]
	y := code[1]

	// Untracked files
	if x == '?' && y == '?' {
		return "added"
	}
	// Deleted
	if x == 'D' || y == 'D' {
		return "deleted"
	}
	// Added (staged)
	if x == 'A' {
		return "added"
	}
	// Modified or renamed
	if x == 'M' || y == 'M' || x == 'R' || y == 'R' {
		return "modified"
	}

	// Default to modified for anything else
	return "modified"
}

// =============================================================================
// Helpers
// =============================================================================

// runGitCommand runs a git command in the given directory and returns stdout.
func runGitCommand(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s failed: %w (stderr: %s)", strings.Join(args, " "), err, stderr.String())
	}

	return stdout.String(), nil
}

// statPathOrFail calls os.Stat and writes the appropriate error response on failure.
// kind is used in error messages (e.g. "directory" or "file").
func statPathOrFail(c *gin.Context, path, kind string) (os.FileInfo, bool) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": kind + " not found", "path": path})
			return nil, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to stat %s: %v", kind, err)})
		return nil, false
	}
	return info, true
}

// requirePathQuery extracts the "path" query parameter or writes a 400 error.
func requirePathQuery(c *gin.Context) (string, bool) {
	p := c.Query("path")
	if p == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path query parameter is required"})
		return "", false
	}
	return p, true
}

// formatWithCommas formats an integer with comma separators (e.g. 10000 → "10,000").
func formatWithCommas(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	var result []byte
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			result = append(result, ',')
		}
		result = append(result, byte(c))
	}
	return string(result)
}

// countLines counts the number of lines in a string.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}
