package api

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Limits for file tree building to prevent OOM when the output directory
// contains a large number of files (e.g. after npm install).
var (
	// maxFileTreeFiles is the maximum number of files to include in a file tree response.
	maxFileTreeFiles = 500
	// maxFileTreeFileSize is the maximum size of a single file's content to include inline.
	// Files larger than this will have their content omitted with isTruncated=true.
	maxFileTreeFileSize = int64(512 * 1024) // 512 KB
)

// getLanguageFromExtension determines the language/type based on file extension
func getLanguageFromExtension(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))

	languageMap := map[string]string{
		".tf":            "hcl",
		".tofu":          "hcl",
		".tfvars":        "hcl",
		".tfstate":       "json",
		".hcl":           "hcl",
		".js":            "javascript",
		".cjs":           "javascript",
		".mjs":           "javascript",
		".jsx":           "jsx",
		".ts":            "typescript",
		".tsx":           "tsx",
		".py":            "python",
		".go":            "go",
		".java":          "java",
		".c":             "c",
		".cpp":           "cpp",
		".cc":            "cpp",
		".cxx":           "cpp",
		".h":             "c",
		".hpp":           "cpp",
		".cs":            "csharp",
		".php":           "php",
		".rb":            "ruby",
		".rs":            "rust",
		".swift":         "swift",
		".kt":            "kotlin",
		".scala":         "scala",
		".sh":            "bash",
		".bash":          "bash",
		".zsh":           "bash",
		".fish":          "bash",
		".ps1":           "powershell",
		".psm1":          "powershell",
		".sql":           "sql",
		".html":          "html",
		".htm":           "html",
		".xml":           "xml",
		".css":           "css",
		".scss":          "scss",
		".sass":          "sass",
		".less":          "less",
		".json":          "json",
		".yaml":          "yaml",
		".yml":           "yaml",
		".toml":          "toml",
		".ini":           "ini",
		".cfg":           "ini",
		".conf":          "ini",
		".md":            "markdown",
		".mdx":           "mdx",
		".rst":           "restructuredtext",
		".tex":           "latex",
		".dockerfile":    "dockerfile",
		".makefile":      "makefile",
		".cmake":         "cmake",
		".gradle":        "gradle",
		".maven":         "xml",
		".pom":           "xml",
		".properties":    "properties",
		".env":           "bash",
		".gitignore":     "gitignore",
		".gitattributes": "gitattributes",
		".editorconfig":  "ini",
		".eslintrc":      "json",
		".prettierrc":    "json",
		".babelrc":       "json",
		".tsconfig":      "json",
		".jsconfig":      "json",
		".package":       "json",
		".lock":          "text",
		".log":           "text",
		".txt":           "text",
		".rtf":           "text",
		".csv":           "csv",
		".tsv":           "tsv",
		".diff":          "diff",
		".patch":         "diff",
	}

	if lang, exists := languageMap[ext]; exists {
		return lang
	}

	// Special cases for files without extensions
	basename := strings.ToLower(filepath.Base(filename))
	if basename == "dockerfile" {
		return "dockerfile"
	}
	if basename == "makefile" {
		return "makefile"
	}
	if basename == "rakefile" {
		return "ruby"
	}
	if basename == "gemfile" {
		return "ruby"
	}
	if basename == "podfile" {
		return "ruby"
	}
	if basename == "vagrantfile" {
		return "ruby"
	}

	return "text"
}

// fileTreeWithContentStats tracks cumulative statistics during a file tree build.
type fileTreeWithContentStats struct {
	totalFiles    int            // total files discovered (including those beyond the limit)
	dirFileCounts map[string]int // file count per top-level subdirectory
}

// buildFileTreeWithContent recursively builds a file tree from a directory,
// reading file contents inline. It enforces limits on the number of files
// and per-file content size to prevent OOM crashes when the directory is very large.
func buildFileTreeWithContent(rootPath string, relativePath string) ([]FileTreeNode, error) {
	stats := &fileTreeWithContentStats{
		dirFileCounts: make(map[string]int),
	}
	tree, err := buildFileTreeWithContentRecursive(rootPath, relativePath, stats)
	if err != nil {
		return nil, err
	}
	return tree, nil
}

// buildFileTreeWithContentRecursive is the internal recursive implementation
// that shares a stats counter across all levels of recursion.
func buildFileTreeWithContentRecursive(rootPath string, relativePath string, stats *fileTreeWithContentStats) ([]FileTreeNode, error) {
	var result []FileTreeNode

	fullPath := filepath.Join(rootPath, relativePath)

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory %s: %w", fullPath, err)
	}

	// Sort entries: directories first, then files, both alphabetically
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir() // directories first
		}
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		entryName := entry.Name()

		// Always skip VCS metadata directories
		if entry.IsDir() && (entryName == ".git" || entryName == ".svn" || entryName == ".hg") {
			continue
		}

		entryRelativePath := filepath.Join(relativePath, entryName)
		entryFullPath := filepath.Join(rootPath, entryRelativePath)

		item := FileTreeNode{
			ID:   entryRelativePath,
			Name: entryName,
		}

		if entry.IsDir() {
			item.Type = "folder"
			children, err := buildFileTreeWithContentRecursive(rootPath, entryRelativePath, stats)
			if err != nil {
				return nil, fmt.Errorf("failed to build file tree for directory %s: %w", entryFullPath, err)
			}
			item.Children = children
		} else {
			item.Type = "file"
			stats.totalFiles++

			// Track file counts per top-level subdirectory for heavy dir detection
			if relativePath != "" {
				topDir := strings.SplitN(filepath.ToSlash(entryRelativePath), "/", 2)[0]
				stats.dirFileCounts[topDir]++
			}

			// If we've exceeded the file limit, still count but don't read content.
			// The caller uses stats.totalFiles to report truncation.
			if stats.totalFiles > maxFileTreeFiles {
				continue
			}

			// Get file info for size
			info, err := entry.Info()
			if err != nil {
				return nil, fmt.Errorf("failed to get file info for %s: %w", entryFullPath, err)
			}

			fileSize := info.Size()

			// Skip content for oversized files, but still include metadata
			if fileSize > maxFileTreeFileSize || isBinaryExt(strings.ToLower(filepath.Ext(entryName))) {
				item.File = &File{
					Name:        entryName,
					Path:        entryRelativePath,
					Language:    getLanguageFromExtension(entryName),
					Size:        fileSize,
					IsTruncated: true,
				}
			} else {
				// Read file contents
				content, err := os.ReadFile(entryFullPath)
				if err != nil {
					return nil, fmt.Errorf("failed to read file %s: %w", entryFullPath, err)
				}

				item.File = &File{
					Name:     entryName,
					Path:     entryRelativePath,
					Content:  string(content),
					Language: getLanguageFromExtension(entryName),
					Size:     fileSize,
				}
			}
		}

		result = append(result, item)
	}

	return result, nil
}

// FileTreeResult is the result of building a file tree, including truncation info.
type FileTreeResult struct {
	Tree          []FileTreeNode
	TotalFiles    int
	TruncatedTree bool
	// HeavyDir is the name of the top-level subdirectory containing the most files,
	// populated only when the tree is truncated to help users identify the culprit.
	HeavyDir string
	// HeavyDirFileCount is the number of files found in HeavyDir.
	HeavyDirFileCount int
}

// buildFileTreeWithContentResult returns the file tree along with metadata
// about truncation so callers can inform the frontend.
func buildFileTreeWithContentResult(rootPath string, relativePath string) (*FileTreeResult, error) {
	stats := &fileTreeWithContentStats{
		dirFileCounts: make(map[string]int),
	}
	tree, err := buildFileTreeWithContentRecursive(rootPath, relativePath, stats)
	if err != nil {
		return nil, err
	}
	truncated := stats.totalFiles > maxFileTreeFiles
	result := &FileTreeResult{
		Tree:          tree,
		TotalFiles:    stats.totalFiles,
		TruncatedTree: truncated,
	}
	if truncated {
		slog.Warn("File tree truncated", "totalFiles", stats.totalFiles, "limit", maxFileTreeFiles, "rootPath", rootPath)
		// Identify the top-level directory with the most files
		var heavyDir string
		var heavyCount int
		for dir, count := range stats.dirFileCounts {
			if count > heavyCount {
				heavyDir = dir
				heavyCount = count
			}
		}
		// Only recommend if the heavy directory has a substantial share of total files
		if heavyCount > stats.totalFiles/2 {
			result.HeavyDir = heavyDir
			result.HeavyDirFileCount = heavyCount
			slog.Warn("Heavy directory detected", "dir", heavyDir, "files", heavyCount, "totalFiles", stats.totalFiles)
		}
	}
	return result, nil
}
