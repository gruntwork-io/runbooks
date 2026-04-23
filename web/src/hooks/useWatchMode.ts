import { useEffect, useRef } from 'react';
import { Events } from '@wailsio/runtime';
import * as WatcherService from '@/bindings/github.com/gruntwork-io/runbooks/services/watcherservice';
import { isDesktop } from '@/lib/wails';

/**
 * Hook to enable watch mode - listens for file changes and triggers a reload.
 *
 * Desktop (Wails) path: calls WatcherService.StartWatch(path), receives a
 * watchID, subscribes to `watch:<watchID>:change` events, and calls
 * WatcherService.Stop(watchID) on unmount.
 *
 * Browser path: subscribes to the legacy /api/watch SSE endpoint. This
 * branch goes away in M5 when Gin is removed.
 */
export function useWatchMode(
  onFileChange: () => void,
  isWatchMode: boolean = false,
  gruntbookPath?: string,
) {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isWatchMode) {
      console.log('[Watch Mode] Not in watch mode, skipping watch');
      return;
    }

    if (isDesktop()) {
      if (!gruntbookPath) {
        console.log('[Watch Mode] Desktop mode but no gruntbook path yet');
        return;
      }

      let watchID: string | null = null;
      let unsubscribe: (() => void) | null = null;
      let cancelled = false;

      (async () => {
        try {
          const result = await WatcherService.StartWatch({ path: gruntbookPath });
          if (cancelled || !result) {
            if (result?.watchId) {
              // Race: effect cleaned up before StartWatch resolved. Release
              // the fsnotify watcher we just allocated.
              await WatcherService.Stop(result.watchId);
            }
            return;
          }
          watchID = result.watchId;
          console.log('[Watch Mode] IPC watcher started', { watchID, path: result.resolvedPath });

          unsubscribe = Events.On(`watch:${watchID}:change`, (event) => {
            console.log('[Watch Mode] File change event:', event.data);
            onFileChange();
          });
        } catch (err) {
          console.log('[Watch Mode] Failed to start IPC watcher:', err);
        }
      })();

      return () => {
        cancelled = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (watchID) {
          console.log('[Watch Mode] Stopping IPC watcher', watchID);
          WatcherService.Stop(watchID).catch((err) => {
            console.log('[Watch Mode] Stop failed:', err);
          });
          watchID = null;
        }
      };
    }

    // Browser / Gin-bridge path.
    const connectToWatchEndpoint = () => {
      try {
        const eventSource = new EventSource('/api/watch');
        eventSourceRef.current = eventSource;

        eventSource.addEventListener('connected', () => {
          console.log('[Watch Mode] Connected to file watcher');
        });

        eventSource.addEventListener('file-change', (event) => {
          console.log('[Watch Mode] File change detected:', event.data);
          onFileChange();
        });

        eventSource.onerror = (error) => {
          console.log('[Watch Mode] Connection error or not available:', error);
          eventSource.close();
          eventSourceRef.current = null;
        };
      } catch (error) {
        console.log('[Watch Mode] Failed to connect to watch endpoint:', error);
      }
    };

    connectToWatchEndpoint();

    return () => {
      if (eventSourceRef.current) {
        console.log('[Watch Mode] Disconnecting from file watcher');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [onFileChange, isWatchMode, gruntbookPath]);
}
