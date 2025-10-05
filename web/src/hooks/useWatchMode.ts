import { useEffect, useRef } from 'react';

/**
 * Hook to enable watch mode - listens for file changes via SSE and triggers a reload
 */
export function useWatchMode(onFileChange: () => void, isWatchMode: boolean = false) {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Only connect to watch endpoint if we're actually in watch mode
    if (!isWatchMode) {
      console.log('[Watch Mode] Not in watch mode, skipping SSE connection');
      return;
    }

    // Try to connect to the watch endpoint
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
          // Close and don't retry - watch mode is not available
          eventSource.close();
          eventSourceRef.current = null;
        };
      } catch (error) {
        console.log('[Watch Mode] Failed to connect to watch endpoint:', error);
      }
    };

    // Attempt to connect
    connectToWatchEndpoint();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        console.log('[Watch Mode] Disconnecting from file watcher');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [onFileChange, isWatchMode]);
}

