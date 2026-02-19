package api

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Types & variables
// ---------------------------------------------------------------------------

// FileRequest represents the request body for the file endpoint
type FileRequest struct {
	Path string `json:"path"`
}

// RunbookConfig holds the configuration for serving a runbook via the API.
type RunbookConfig struct {
	LocalPath             string // Resolved local path to the runbook file
	RemoteSourceURL       string // Original remote URL (e.g., GitHub URL); empty for local runbooks
	IsWatchMode           bool   // Whether live file-watching is enabled
	UseExecutableRegistry bool   // Whether to use the pre-built executable registry
}

// FileMetadata holds the content and metadata for a file read from disk.
type FileMetadata struct {
	Path        string
	Content     string
	ContentHash string
	Language    string
	Size        int64
}

// ToJSON converts the metadata into a Gin-compatible JSON map.
func (m *FileMetadata) ToJSON() gin.H {
	return gin.H{
		"path":        m.Path,
		"content":     m.Content,
		"contentHash": m.ContentHash,
		"language":    m.Language,
		"size":        m.Size,
	}
}

// allowedAssetContentTypes maps file extensions to their MIME types.
// This is the single source of truth for both allowed-extension checks and content-type resolution.
var allowedAssetContentTypes = map[string]string{
	// Images
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".svg":  "image/svg+xml",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	// Documents
	".pdf": "application/pdf",
	// Media
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".ogg":  "video/ogg",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".m4a":  "audio/mp4",
	".avi":  "video/x-msvideo",
	".mov":  "video/quicktime",
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// HandleRunbookRequest returns the contents of the runbook file directly.
// This handler is used for GET /api/runbook requests.
func HandleRunbookRequest(cfg RunbookConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		serveRunbookContent(c, cfg)
	}
}

// HandleFileRequest returns the contents of a file at the given path.
// The path is expected to be a file path, not a directory.
// This handler is used for POST /api/file requests with JSON body.
func HandleFileRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req FileRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request",
				"details": "Request body must be valid JSON with a 'path' field",
			})
			return
		}

		filePath := runbookPath
		if req.Path != "" {
			filePath = filepath.Join(filepath.Dir(runbookPath), req.Path)
		}
		serveFileAsJSON(c, filePath)
	}
}

// HandleRunbookAssetsRequest serves static assets from the runbook's assets directory.
// This endpoint serves raw files (images, PDFs, media) with appropriate content types.
func HandleRunbookAssetsRequest(runbookPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestedPath := c.Param("filepath")
		if requestedPath == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "Invalid request",
				"details": "No file path provided",
			})
			return
		}

		if requestedPath[0] == '/' {
			requestedPath = requestedPath[1:]
		}

		cleanPath := filepath.Clean(requestedPath)

		if filepath.IsAbs(cleanPath) || len(cleanPath) > 0 && cleanPath[0] == '.' {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid path",
				"details": "Path must be relative and cannot contain '..'",
			})
			return
		}

		if !isAllowedAssetExtension(cleanPath) {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "File type not allowed",
				"details": "Only image, PDF, and media files are allowed",
			})
			return
		}

		runbookDir := filepath.Dir(runbookPath)
		fullPath := filepath.Join(runbookDir, "assets", cleanPath)

		assetsDir := filepath.Join(runbookDir, "assets")
		relPath, err := filepath.Rel(assetsDir, fullPath)
		if err != nil || len(relPath) >= 2 && relPath[0:2] == ".." {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid path",
				"details": "Path must be within the assets directory",
			})
			return
		}

		fileInfo, err := os.Stat(fullPath)
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{
				"error":   "File not found",
				"details": "The requested asset was not found",
			})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":   "Failed to access file",
				"details": err.Error(),
			})
			return
		}

		if fileInfo.IsDir() {
			c.JSON(http.StatusForbidden, gin.H{
				"error":   "Invalid request",
				"details": "Cannot serve directories",
			})
			return
		}

		contentType := getContentType(cleanPath)
		c.Header("Content-Type", contentType)
		c.File(fullPath)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// readFileMetadata reads a file and returns its content and metadata.
func readFileMetadata(filePath string) (*FileMetadata, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	fileInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}

	return &FileMetadata{
		Path:        filePath,
		Content:     string(content),
		ContentHash: computeContentHash(string(content)),
		Language:    getLanguageFromExtension(filepath.Base(filePath)),
		Size:        fileInfo.Size(),
	}, nil
}

// sendFileError maps a file-read error to an appropriate HTTP error response.
func sendFileError(c *gin.Context, filePath string, err error) {
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "File not found",
			"details": "The file at the path " + filePath + " was not found.",
		})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{
		"error":   "Failed to read file",
		"details": "The file at the path " + filePath + " could not be read.",
	})
}

// serveRunbookContent serves a runbook file as JSON, adding runbook-specific fields to the response.
func serveRunbookContent(c *gin.Context, cfg RunbookConfig) {
	meta, err := readFileMetadata(cfg.LocalPath)
	if err != nil {
		sendFileError(c, cfg.LocalPath, err)
		return
	}

	response := meta.ToJSON()
	response["useExecutableRegistry"] = cfg.UseExecutableRegistry

	if cfg.IsWatchMode {
		response["isWatchMode"] = true
	}

	if cfg.RemoteSourceURL != "" {
		response["remoteSource"] = cfg.RemoteSourceURL
	}

	// In live-reload mode, validate for duplicate components on-demand.
	// In registry mode, warnings are captured once at server startup during registry creation.
	// In live-reload mode, no registry exists, so we validate on each request for the runbook.
	if !cfg.UseExecutableRegistry {
		warnings, err := validateRunbook(cfg.LocalPath)
		if err != nil {
			slog.Warn("Failed to validate runbook for duplicates", "error", err)
		} else {
			response["warnings"] = warnings
		}
	}

	c.JSON(http.StatusOK, response)
}

// serveFileAsJSON reads a file and returns its content as a JSON response with metadata.
func serveFileAsJSON(c *gin.Context, filePath string) {
	meta, err := readFileMetadata(filePath)
	if err != nil {
		sendFileError(c, filePath, err)
		return
	}
	c.JSON(http.StatusOK, meta.ToJSON())
}

// isAllowedAssetExtension checks if the file extension is in the whitelist of allowed types.
func isAllowedAssetExtension(filename string) bool {
	ext := filepath.Ext(filename)
	_, ok := allowedAssetContentTypes[ext]
	return ok
}

// getContentType returns the MIME type for a file based on its extension.
func getContentType(filename string) string {
	ext := filepath.Ext(filename)
	if contentType, ok := allowedAssetContentTypes[ext]; ok {
		return contentType
	}
	return "application/octet-stream"
}
