package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Minimal valid PNG file (8-byte header). Defined once as a test fixture.
var testPNGBytes = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

func setupWorkspaceTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/workspace/tree", HandleWorkspaceTree())
	r.GET("/api/workspace/file", HandleWorkspaceFile())
	r.GET("/api/workspace/changes", HandleWorkspaceChanges())
	return r
}

// createTempDirWithFiles creates a temp dir with nested files for testing.
func createTempDirWithFiles(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	// Create nested structure
	os.MkdirAll(filepath.Join(dir, "src", "utils"), 0755)
	os.MkdirAll(filepath.Join(dir, "docs"), 0755)

	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test\n"), 0644)
	os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main\n"), 0644)
	os.WriteFile(filepath.Join(dir, "src", "utils", "helper.go"), []byte("package utils\n"), 0644)
	os.WriteFile(filepath.Join(dir, "docs", "guide.md"), []byte("# Guide\n"), 0644)

	return dir
}

// createTempGitRepo creates a temp dir that is a git repo with an initial commit.
func createTempGitRepo(t *testing.T) string {
	t.Helper()
	dir := createTempDirWithFiles(t)

	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		{"git", "add", "."},
		{"git", "commit", "-m", "initial"},
	}

	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git command %v failed: %v\n%s", args, err, out)
		}
	}

	return dir
}

func TestWorkspaceTreeFullStructure(t *testing.T) {
	dir := createTempDirWithFiles(t)
	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/tree?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceTreeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.TotalFiles != 4 {
		t.Errorf("expected 4 files, got %d", resp.TotalFiles)
	}

	// Verify structure: should have docs/, src/, README.md at top level
	topNames := make(map[string]bool)
	for _, node := range resp.Tree {
		topNames[node.Name] = true
	}
	for _, expected := range []string{"docs", "src", "README.md"} {
		if !topNames[expected] {
			t.Errorf("missing top-level entry: %s", expected)
		}
	}
}

func TestWorkspaceTreeSkipsGitDir(t *testing.T) {
	dir := createTempGitRepo(t)
	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/tree?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceTreeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	// .git should NOT appear in the tree
	for _, node := range resp.Tree {
		if node.Name == ".git" {
			t.Error(".git directory should be excluded from tree")
		}
	}

	// Verify git metadata is populated for a git repo
	if resp.GitInfo == nil {
		t.Fatal("expected gitInfo for a git repo")
	}
	if resp.GitInfo.Ref == "" {
		t.Error("expected non-empty ref")
	}
	if resp.GitInfo.RefType == "" {
		t.Error("expected non-empty refType")
	}
	if resp.GitInfo.CommitSha == "" {
		t.Error("expected non-empty commit SHA")
	}
	// RemoteURL is expected to be empty (no remote configured in test repo)
}

func TestWorkspaceTreeMaxFiles(t *testing.T) {
	// Override the limit to a small value so we don't create 10,001 files in a test.
	orig := maxWorkspaceFiles
	maxWorkspaceFiles = 5
	t.Cleanup(func() { maxWorkspaceFiles = orig })

	dir := t.TempDir()

	// Create one more file than the limit
	for i := 0; i < maxWorkspaceFiles+1; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("file_%d.txt", i)), []byte("x"), 0644)
	}

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/tree?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413, got %d", w.Code)
	}
}

func TestWorkspaceFileContent(t *testing.T) {
	dir := createTempDirWithFiles(t)
	router := setupWorkspaceTestRouter()

	filePath := filepath.Join(dir, "README.md")
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/file?path="+filePath, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceFileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Content != "# Test\n" {
		t.Errorf("unexpected content: %q", resp.Content)
	}
	if resp.Language != "markdown" {
		t.Errorf("unexpected language: %s", resp.Language)
	}
}

func TestWorkspaceFileTooLarge(t *testing.T) {
	// Override the limit to a tiny value so we don't allocate 1MB+ in a test.
	orig := maxFileContentSize
	maxFileContentSize = 64
	t.Cleanup(func() { maxFileContentSize = orig })

	dir := t.TempDir()
	largePath := filepath.Join(dir, "large.txt")

	// Create a file just over the limit
	data := make([]byte, int(maxFileContentSize)+1)
	os.WriteFile(largePath, data, 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/file?path="+largePath, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp WorkspaceFileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.IsTooLarge {
		t.Error("expected isTooLarge: true")
	}
	if resp.Content != "" {
		t.Error("expected empty content for too-large file")
	}
}

func TestWorkspaceFileBinaryByContent(t *testing.T) {
	// Tests null-byte detection for files whose extension is NOT in binaryExtensions.
	// Uses .customdata so the handler reads the file and checks for null bytes
	// rather than short-circuiting on the extension.
	dir := t.TempDir()
	binPath := filepath.Join(dir, "data.customdata")

	data := []byte("hello\x00world")
	os.WriteFile(binPath, data, 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/file?path="+binPath, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp WorkspaceFileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.IsBinary {
		t.Error("expected isBinary: true for file with null bytes")
	}
	if resp.Content != "" {
		t.Error("expected empty content for binary file")
	}
}

func TestWorkspaceFileBinaryByExtension(t *testing.T) {
	// Tests that known binary extensions (e.g. .zip) are detected without reading file content.
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "archive.zip")

	os.WriteFile(zipPath, []byte("not real zip data"), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/file?path="+zipPath, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp WorkspaceFileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.IsBinary {
		t.Error("expected isBinary: true for .zip file")
	}
	if resp.Content != "" {
		t.Error("expected empty content for binary file")
	}
}

func TestWorkspaceFileImage(t *testing.T) {
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "test.png")
	os.WriteFile(pngPath, testPNGBytes, 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/file?path="+pngPath, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp WorkspaceFileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.IsImage {
		t.Error("expected isImage: true for .png file")
	}
	if resp.MimeType != "image/png" {
		t.Errorf("expected mimeType image/png, got %s", resp.MimeType)
	}
	if resp.DataUri == "" {
		t.Error("expected non-empty dataUri")
	}
}

func TestWorkspaceChangesEmpty(t *testing.T) {
	dir := createTempGitRepo(t)
	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.TotalChanges != 0 {
		t.Errorf("expected 0 changes, got %d", resp.TotalChanges)
	}
}

func TestWorkspaceChangesDetected(t *testing.T) {
	dir := createTempGitRepo(t)

	// Modify a file
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Updated\n"), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.TotalChanges != 1 {
		t.Errorf("expected 1 change, got %d", resp.TotalChanges)
	}
	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 change entry, got %d", len(resp.Changes))
	}

	change := resp.Changes[0]
	if change.Path != "README.md" {
		t.Errorf("expected path README.md, got %s", change.Path)
	}
	if change.ChangeType != "modified" {
		t.Errorf("expected changeType modified, got %s", change.ChangeType)
	}
}

func TestWorkspaceChangesIncludesDiffContent(t *testing.T) {
	dir := createTempGitRepo(t)

	// Modify a file
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Updated\n"), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(resp.Changes))
	}

	change := resp.Changes[0]
	if change.OriginalContent != "# Test\n" {
		t.Errorf("expected original content %q, got %q", "# Test\n", change.OriginalContent)
	}
	if change.NewContent != "# Updated\n" {
		t.Errorf("expected new content %q, got %q", "# Updated\n", change.NewContent)
	}
}

func TestWorkspaceChangesSingleFileDiff(t *testing.T) {
	dir := createTempGitRepo(t)

	// Modify a file
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Updated\n"), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir+"&file=README.md", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(resp.Changes))
	}

	change := resp.Changes[0]
	if change.OriginalContent != "# Test\n" {
		t.Errorf("expected original content %q, got %q", "# Test\n", change.OriginalContent)
	}
	if change.NewContent != "# Updated\n" {
		t.Errorf("expected new content %q, got %q", "# Updated\n", change.NewContent)
	}
}

func TestWorkspaceChangesTruncatesLargeDiff(t *testing.T) {
	// Override the limit to a tiny value so we don't generate 50KB+ in a test.
	orig := maxDiffSizePerFile
	maxDiffSizePerFile = 32
	t.Cleanup(func() { maxDiffSizePerFile = orig })

	dir := createTempGitRepo(t)

	// Modify README.md with content that exceeds the diff limit
	bigContent := strings.Repeat("this is a long line of content\n", 5)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte(bigContent), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(resp.Changes))
	}

	change := resp.Changes[0]
	if !change.DiffTruncated {
		t.Error("expected diffTruncated: true when diff exceeds limit")
	}
	if change.OriginalContent != "" || change.NewContent != "" {
		t.Error("expected empty content when diff is truncated")
	}
}

func TestWorkspaceTreeNotFound(t *testing.T) {
	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/tree?path=/nonexistent/path", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestWorkspaceTreeMissingPath(t *testing.T) {
	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/tree", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestWorkspaceChangesNewFile(t *testing.T) {
	dir := createTempGitRepo(t)

	// Add a new untracked file
	os.WriteFile(filepath.Join(dir, "new_file.txt"), []byte("new content\n"), 0644)

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	found := false
	for _, change := range resp.Changes {
		if change.Path == "new_file.txt" {
			found = true
			if change.ChangeType != "added" {
				t.Errorf("expected changeType added, got %s", change.ChangeType)
			}
			if !strings.Contains(change.NewContent, "new content") {
				t.Error("expected new file content")
			}
		}
	}
	if !found {
		t.Error("new_file.txt not found in changes")
	}
}

func TestWorkspaceChangesDeletedFile(t *testing.T) {
	dir := createTempGitRepo(t)

	// Delete a committed file
	os.Remove(filepath.Join(dir, "README.md"))

	router := setupWorkspaceTestRouter()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/workspace/changes?path="+dir, nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceChangesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	found := false
	for _, change := range resp.Changes {
		if change.Path == "README.md" {
			found = true
			if change.ChangeType != "deleted" {
				t.Errorf("expected changeType deleted, got %s", change.ChangeType)
			}
			if change.OriginalContent != "# Test\n" {
				t.Errorf("expected original content from HEAD %q, got %q", "# Test\n", change.OriginalContent)
			}
			if change.NewContent != "" {
				t.Errorf("expected empty newContent for deleted file, got %q", change.NewContent)
			}
		}
	}
	if !found {
		t.Error("README.md not found in changes after deletion")
	}
}
