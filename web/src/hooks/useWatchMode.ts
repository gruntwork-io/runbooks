import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { Events } from '@wailsio/runtime';
import * as WatcherService from '@/bindings/github.com/gruntwork-io/runbooks/services/watcherservice';
import { isDesktop } from '@/lib/wails';

// Zod schemas mirroring the Go WatchChangeEvent / WatchDriftEvent structs.
// Event payloads aren't generated as bindings models because they flow
// through the Emitter rather than method return values, so we declare
// the shape here alongside the consumer.
const DriftChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['added', 'modified', 'removed']),
});

const WatchDriftEventSchema = z.object({
  changes: z.array(DriftChangeSchema),
  at: z.string(),
});

export type DriftChange = z.infer<typeof DriftChangeSchema>;
export type WatchDriftEvent = z.infer<typeof WatchDriftEventSchema>;

export interface UseWatchModeOptions {
  /**
   * Path to the gruntbook. Watching is started once this is defined.
   */
  gruntbookPath?: string;

  /**
   * Gruntbook-root-relative output directory, excluded from the drift
   * snapshot so Command-block artefacts don't trigger spurious warnings.
   */
  outputRelPath?: string;

  /**
   * True for Author Mode (hot-reload on change), false for Consumer Mode
   * (drift banner only).
   */
  isAuthorMode: boolean;

  /**
   * Fired in Author Mode when the gruntbook file itself is edited.
   */
  onFileChange: () => void;

  /**
   * Fired in both modes when the tree drifts from the baseline. Consumer
   * mode surfaces this as a banner; Author Mode can ignore it (auto-reload
   * already handles the response) but we still pass it through so the UI
   * can show "changed files" in author views later.
   */
  onDrift?: (event: WatchDriftEvent) => void;
}

/**
 * Hook that subscribes to gruntbook file-watcher events over Wails IPC.
 *
 * Calls WatcherService.StartWatch once per gruntbook path and subscribes
 * to both the `:change` and `:drift` topics for that watch. Returns a
 * resetSnapshot callback so the drift banner's "Reload" action can
 * re-baseline the tree before the next edit is measured.
 *
 * Browser path (legacy /api/watch SSE) is preserved for the author-mode
 * reload until Gin is removed; it does not support drift detection
 * because the legacy endpoint only emits file-change events.
 */
export function useWatchMode(opts: UseWatchModeOptions) {
  const { gruntbookPath, outputRelPath, isAuthorMode, onFileChange, onDrift } = opts;

  const eventSourceRef = useRef<EventSource | null>(null);
  const watchIDRef = useRef<string | null>(null);
  // Keep the latest callbacks in refs so the effect doesn't re-subscribe
  // every time the parent re-renders. Re-subscribing would tear down the
  // fsnotify watcher mid-edit and lose the baseline snapshot.
  const onFileChangeRef = useRef(onFileChange);
  const onDriftRef = useRef(onDrift);
  const isAuthorModeRef = useRef(isAuthorMode);
  onFileChangeRef.current = onFileChange;
  onDriftRef.current = onDrift;
  isAuthorModeRef.current = isAuthorMode;

  useEffect(() => {
    if (isDesktop()) {
      if (!gruntbookPath) {
        return;
      }

      let unsubscribes: Array<() => void> = [];
      let cancelled = false;

      (async () => {
        try {
          const result = await WatcherService.StartWatch({
            path: gruntbookPath,
            outputRelPath: outputRelPath ?? '',
          });
          if (cancelled || !result) {
            if (result?.watchId) {
              await WatcherService.Stop(result.watchId);
            }
            return;
          }
          watchIDRef.current = result.watchId;
          console.log('[Watch Mode] IPC watcher started', {
            watchID: result.watchId,
            path: result.resolvedPath,
          });

          unsubscribes.push(
            Events.On(`watch:${result.watchId}:change`, () => {
              if (isAuthorModeRef.current) {
                onFileChangeRef.current();
              }
            }),
          );

          unsubscribes.push(
            Events.On(`watch:${result.watchId}:drift`, (ev) => {
              const parsed = WatchDriftEventSchema.safeParse(ev.data);
              if (!parsed.success) {
                console.error('[Watch Mode] Invalid drift event:', parsed.error);
                return;
              }
              if (onDriftRef.current) {
                onDriftRef.current(parsed.data);
              }
            }),
          );
        } catch (err) {
          console.log('[Watch Mode] Failed to start IPC watcher:', err);
        }
      })();

      return () => {
        cancelled = true;
        for (const fn of unsubscribes) fn();
        unsubscribes = [];
        const id = watchIDRef.current;
        if (id) {
          watchIDRef.current = null;
          WatcherService.Stop(id).catch((err) => {
            console.log('[Watch Mode] Stop failed:', err);
          });
        }
      };
    }

    // Browser / Gin-bridge path. Author-mode reload only; no drift.
    if (!isAuthorMode) {
      return;
    }
    const connectToWatchEndpoint = () => {
      try {
        const eventSource = new EventSource('/api/watch');
        eventSourceRef.current = eventSource;

        eventSource.addEventListener('file-change', () => {
          onFileChangeRef.current();
        });

        eventSource.onerror = () => {
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
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [gruntbookPath, outputRelPath, isAuthorMode]);

  const resetSnapshot = useCallback(async () => {
    const id = watchIDRef.current;
    if (!id) return;
    try {
      await WatcherService.ResetSnapshot({
        watchId: id,
        outputRelPath: outputRelPath ?? '',
      });
    } catch (err) {
      console.log('[Watch Mode] ResetSnapshot failed:', err);
    }
  }, [outputRelPath]);

  return { resetSnapshot };
}
