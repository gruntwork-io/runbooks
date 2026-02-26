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

// heavyDirs are directories that are known to contain huge numbers of files
// and should be skipped when building file trees for template output.
var heavyDirs = map[string]bool{
	"node_modules":    true,
	".terraform":      true,
	"__pycache__":     true,
	".venv":           true,
	"vendor":          true,
	"dist":            true,
	"build":           true,
	".next":           true,
	".nuxt":           true,
}

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

// fileTreeStats tracks cumulative statistics during a file tree build.
type fileTreeStats struct {
	totalFiles int // total files discovered (including those beyond the limit)
}

// buildFileTree recursively builds a file tree structure from a directory.
// It enforces limits on the number of files and per-file content size to
// prevent OOM crashes when the output directory is very large.
func buildFileTree(rootPath string, relativePath string) ([]FileTreeNode, error) {
	stats := &fileTreeStats{}
	tree, err := buildFileTreeRecursive(rootPath, relativePath, stats)
	if err != nil {
		return nil, err
	}
	return tree, nil
}

// buildFileTreeRecursive is the internal recursive implementation that shares
// a stats counter across all levels of recursion.
func buildFileTreeRecursive(rootPath string, relativePath string, stats *fileTreeStats) ([]FileTreeNode, error) {
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

		// Skip VCS directories and known heavy directories
		if entry.IsDir() && (entryName == ".git" || entryName == ".svn" || entryName == ".hg" || heavyDirs[entryName]) {
			if heavyDirs[entryName] {
				slog.Debug("Skipping heavy directory in file tree", "dir", entryName, "path", filepath.Join(relativePath, entryName))
			}
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
			children, err := buildFileTreeRecursive(rootPath, entryRelativePath, stats)
			if err != nil {
				return nil, fmt.Errorf("failed to build file tree for directory %s: %w", entryFullPath, err)
			}
			item.Children = children
		} else {
			item.Type = "file"
			stats.totalFiles++

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
}

// buildFileTreeWithRoot returns the file tree directly without wrapping in a root folder.
// It also returns metadata about truncation so callers can inform the frontend.
func buildFileTreeWithRoot(rootPath string, relativePath string) (*FileTreeResult, error) {
	stats := &fileTreeStats{}
	tree, err := buildFileTreeRecursive(rootPath, relativePath, stats)
	if err != nil {
		return nil, err
	}
	truncated := stats.totalFiles > maxFileTreeFiles
	if truncated {
		slog.Warn("File tree truncated", "totalFiles", stats.totalFiles, "limit", maxFileTreeFiles, "rootPath", rootPath)
	}
	return &FileTreeResult{
		Tree:          tree,
		TotalFiles:    stats.totalFiles,
		TruncatedTree: truncated,
	}, nil
}
