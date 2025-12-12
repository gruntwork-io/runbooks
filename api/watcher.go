package api

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gin-gonic/gin"
)

// FileWatcher manages file watching for runbook files
type FileWatcher struct {
	watcher   *fsnotify.Watcher
	filePath  string
	clients   map[chan string]bool
	clientsMu sync.RWMutex
}

// NewFileWatcher creates a new file watcher for the given file path
func NewFileWatcher(filePath string) (*FileWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	// Watch the directory containing the file (fsnotify watches directories)
	dir := filepath.Dir(filePath)
	err = watcher.Add(dir)
	if err != nil {
		watcher.Close()
		return nil, err
	}

	fw := &FileWatcher{
		watcher:  watcher,
		filePath: filePath,
		clients:  make(map[chan string]bool),
	}

	// Start watching in a goroutine
	go fw.watch()

	return fw, nil
}

// watch listens for file system events and notifies clients
func (fw *FileWatcher) watch() {
	// Debounce rapid file changes (editors often write multiple times)
	var debounceTimer *time.Timer
	debounceDuration := 300 * time.Millisecond

	for {
		select {
		case event, ok := <-fw.watcher.Events:
			if !ok {
				return
			}

			// Only care about Write and Create events for our specific file
			if (event.Op&fsnotify.Write == fsnotify.Write || event.Op&fsnotify.Create == fsnotify.Create) &&
				event.Name == fw.filePath {
				
				slog.Info("File change detected", "file", event.Name, "op", event.Op)

				// Reset debounce timer
				if debounceTimer != nil {
					debounceTimer.Stop()
				}

				debounceTimer = time.AfterFunc(debounceDuration, func() {
					fw.notifyClients("reload")
				})
			}

		case err, ok := <-fw.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("File watcher error", "error", err)
		}
	}
}

// notifyClients sends a message to all connected SSE clients
func (fw *FileWatcher) notifyClients(message string) {
	fw.clientsMu.RLock()
	defer fw.clientsMu.RUnlock()

	for client := range fw.clients {
		select {
		case client <- message:
		default:
			// Client channel is full or closed, skip
		}
	}
}

// Subscribe adds a new client channel to receive notifications
func (fw *FileWatcher) Subscribe(client chan string) {
	fw.clientsMu.Lock()
	defer fw.clientsMu.Unlock()
	fw.clients[client] = true
}

// Unsubscribe removes a client channel from receiving notifications
func (fw *FileWatcher) Unsubscribe(client chan string) {
	fw.clientsMu.Lock()
	defer fw.clientsMu.Unlock()
	delete(fw.clients, client)
	close(client)
}

// Close closes the file watcher
func (fw *FileWatcher) Close() error {
	return fw.watcher.Close()
}

// HandleWatchSSE creates a gin handler for Server-Sent Events
func HandleWatchSSE(fileWatcher *FileWatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Set SSE headers
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")

		// Create a channel for this client
		clientChan := make(chan string, 10)
		fileWatcher.Subscribe(clientChan)
		defer fileWatcher.Unsubscribe(clientChan)

		// Send initial connection message
		c.SSEvent("connected", "ok")
		c.Writer.Flush()

		// Listen for messages and client disconnect
		clientGone := c.Request.Context().Done()
		for {
			select {
			case msg := <-clientChan:
				c.SSEvent("file-change", msg)
				c.Writer.Flush()
			case <-clientGone:
				slog.Info("SSE client disconnected")
				return
			}
		}
	}
}

// resolveRunbookPath resolves the runbook path to an actual file
// If it's a directory, it looks for runbook.mdx or runbook.md
func resolveRunbookPath(path string) (string, error) {
	fileInfo, err := os.Stat(path)
	if err != nil {
		return "", err
	}

	if fileInfo.IsDir() {
		// Try runbook.mdx first, then runbook.md
		candidates := []string{"runbook.mdx", "runbook.md"}
		for _, candidate := range candidates {
			fullPath := filepath.Join(path, candidate)
			slog.Info("Looking for runbook", "path", fullPath)
			if _, err := os.Stat(fullPath); err == nil {
				return fullPath, nil
			}
		}
		return "", fmt.Errorf("no runbook found in directory %s", path)
	}

	return path, nil
}

