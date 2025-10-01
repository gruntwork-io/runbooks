package api

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// buildFileTree recursively builds a file tree structure from a directory
func buildFileTree(rootPath string, relativePath string) ([]FileTreeNode, error) {
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
		entryRelativePath := filepath.Join(relativePath, entryName)
		entryFullPath := filepath.Join(rootPath, entryRelativePath)

		// Skip hidden files and directories
		if strings.HasPrefix(entryName, ".") {
			continue
		}

		item := FileTreeNode{
			ID:   entryRelativePath,
			Name: entryName,
		}

		if entry.IsDir() {
			item.Type = "folder"
			children, err := buildFileTree(rootPath, entryRelativePath)
			if err != nil {
				return nil, fmt.Errorf("failed to build file tree for directory %s: %w", entryFullPath, err)
			}
			item.Children = children
		} else {
			item.Type = "file"

			// Get file info for size
			info, err := entry.Info()
			if err != nil {
				return nil, fmt.Errorf("failed to get file info for %s: %w", entryFullPath, err)
			}

			// Read file contents
			content, err := os.ReadFile(entryFullPath)
			if err != nil {
				return nil, fmt.Errorf("failed to read file %s: %w", entryFullPath, err)
			}

			// Create File struct with all metadata
			item.File = &File{
				Name:     entryName,
				Path:     entryRelativePath,
				Content:  string(content),
				Language: getLanguageFromExtension(entryName),
				Size:     info.Size(),
			}
		}

		result = append(result, item)
	}

	return result, nil
}

// buildFileTreeWithRoot returns the file tree directly without wrapping in a root folder
func buildFileTreeWithRoot(rootPath string, relativePath string) ([]FileTreeNode, error) {
	// Build the file tree and return it directly
	return buildFileTree(rootPath, relativePath)
}
