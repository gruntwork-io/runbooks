# Draft: WP 2.8, the session store (not committed; add files by name)

Goal: a person who closes the app and opens the same runbook again finds form values and
credentials kept, run history dropped for sessions older versions wrote, and nothing restored
lets an untrusted or changed runbook run.

Stated size: 3 PRs (contract; store + SQLite layer; restore through the engine), ~15 files.

## Survey (today's app)
- electron/main/session-storage.ts opens `<userData>/v0/sessions/db/sessions.db` with
  `node:sqlite` (built into Electron's Node and Bun; no package, nothing in bun.lock), via
  src/layers/NodeSqlite.ts. Falls back to `:memory:` when the file cannot be opened.
- Schema (src/domain/session/store.ts, user_version 1): sessions (id, name, runbook_path,
  remote_source, dir, working_dir, launch_dir, env BLOB, active_worktree, execution_count,
  created/last_launched/last_activity, vcs_bindings JSON, finished_at), session_worktrees,
  session_events (seq, session_id, at, block_id, kind, payload BLOB). STRICT, WAL.
- Saves: env changes (encrypted), every block event: inputs (form values, submitted), run
  (status, exit code, last 500 lines / 64 KiB of log, outputs incl. sensitive, error),
  render, clone, pull-request, auth (AWS keys, Azure env + config dir, ...), overrides, review.
- Secrets: safeStorage (Keychain/DPAPI/secret service) encrypts env and every payload; on
  Linux basic_text, nothing encrypted is saved. Payloads > 1M chars refused.
- Retention: none. Sessions kept until the person deletes one (dir moved to trash).
- Keyed: local runbook by path, remote by URL; most recently launched unfinished one resumed.
- Trust: none today.

## Design (from scratch)
- makeSession takes what was saved (values, runs, credentials) beside the document; `update`
  (the one mutation path) hands a saver what changed; engine restores trust only when the
  saved trusted hash is the document's combined hash.
- Credential restore = first detection with a `values` source holding the block's own saved
  values (`from` = its own id); contract change to the credential protocol's promise.
- Protocol: SessionView.resumed { lastUsed, problems } so a client can say why run history or
  trust was not kept.

## State (2026-11-25): done, handed back
Branches (stacked on rebuild/p2-settings-import ade9a99a), all checks green per commit, 50 mutations all caught:
- PR 25 rebuild/p2-sessions-contract cd12001b; PR 26 -store c54d67a7; PR 27 -saved 5cb11fc8;
  PR 28 -resume 995985c4; PR 29 -credentials 28ea0356; PR 30 -retention 3cd837b5.
PR bodies: scratchpad/prs/p2-sessions-*.md (decisions, gaps, evidence live there).
Scripts: scratchpad/sessions/checks.sh, mutate.py, m-final.json (+ m-final.out).

## Open
- Decision 6 reading: built for this store's versions; today's v0 sessions.db not imported
  (= "drop all" for an upgrade from today's app). Importer outline in PR 27 body.
