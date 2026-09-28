/**
 * localStorage key for per-runbook UI state (e.g. a block's "done" mark or a
 * task-list checkbox). `scope` is RunbookContext's `storageScope`, the
 * runbook's full identity, so the same `id` in different runbooks doesn't
 * share state; it falls back to "default" outside a runbook.
 */
export function runbookStorageKey(prefix: string, scope: string | undefined, id: string): string {
  return `${prefix}:${scope ?? 'default'}:${id}`
}
