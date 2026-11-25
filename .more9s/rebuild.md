# Runbooks rebuild: stack index

The running index of the rebuild stack. Update it whenever the stack changes.

- Spec: "Runbooks rebuild master plan", https://claude.ai/artifact/8YYhibKcx1Q3HZQGypHNE2 (wins on conflicts),
  and "Runbooks block contract proposal", https://claude.ai/artifact/EEiqpN8kjtoekEV2QX6Qrh (JSON Schema sketch, RFC-188 notes).
- Integration branch: `rebuild/main`, cut from `main` at ac543199 (2026-11-24).
- Every PR is a draft. The bottom PR targets `rebuild/main`; each later PR targets the branch below it.
- Nothing merges and no PR leaves draft without the human.

## Finish line

The top of the stack passes, in CI:

- all 37 runbook fixtures, with `baseline/behaviour-changes/*.patch` applied, through the new `runbooks test`;
- all 25 e2e specs, plus the phase 0 files-panel and system specs, against the new app;
- the app's CSP has no `'unsafe-eval'`;
- no block runs against the fake credential provider;
- a toy block added in one folder and two registry lines passes in the app, the CLI and MCP.

## New tree layout

| Path | Package | May import |
|---|---|---|
| `blocks/core/` | block contract | `effect` |
| `packages/core/` | document, parser, engine, protocol, service interfaces, domain | `blocks/core`, `effect` |
| `blocks/<name>/` | one block each | `blocks/core`, `packages/core` |
| `blocks/index.ts`, `blocks/views.ts` | registry, view map | block folders |
| `packages/platform-node/` | layers: the only Node I/O and SDK imports | `packages/core` |
| `packages/app-main/` | Electron main: IPC transport | core, platform-node, `blocks/index.ts` |
| `packages/app-renderer/` | React: walks the document | core (protocol only), `blocks/views.ts` |
| `packages/cli/` | `runbooks` CLI: open, test, validate, mcp | core, platform-node, `blocks/index.ts` |
| `plugin/` | `base.schema.json`, `credential.schema.json` | none |
| `signin/` | track A Rust binaries, liftable into their own repo | none |
| `baseline/` | frozen baseline list, props, security test names, behaviour-change patches | none |

## Stack

Status: planned, open (draft PR open), green (CI passed on the head), red.
"Green" excludes `Pull Request has non-contributor approval`, which fails on every PR until a human who has not pushed to it approves.

Phase 0 was reordered on 2026-11-24 so dependencies point down the stack: the auth contract owns the credential lifecycle, and the engine protocol carries it.

| # | PR | Phase | Branch | Base | Status | Work products |
|---|---|---|---|---|---|---|
| 1 | #496 | 0 | `rebuild/p0-block-contract` | `rebuild/main` | green | 0.2 |
| 2 | #497 | 0 | `rebuild/p0-document` | p0-block-contract | green | 0.4 |
| 3 | #499 | 0 | `rebuild/p0-plugin-transport` | p0-document | green | 0.5 |
| 4 | #501 | 0 | `rebuild/p0-auth-contract` | p0-plugin-transport | green | 0.6 |
| 5 | #502 | 0 | `rebuild/p0-engine-protocol` | p0-auth-contract | green | 0.3 |
| 6 | #503 | 0 | `rebuild/p0-cli-contract` | p0-engine-protocol | green | 0.7 |
| 7 | #504 | 0 | `rebuild/p0-security-tests` | p0-cli-contract | green | 0.11 |
| 8 | #505 | 0 | `rebuild/p0-schema-bundle` | p0-security-tests | green | 0.12 |
| 9 | #507 | 0 | `rebuild/p0-e2e-files-panel` | p0-schema-bundle | green | 0.9 |
| 10 | #508 | 0 | `rebuild/p0-e2e-system` | p0-e2e-files-panel | open | 0.10 |
| 11 | #509 | 0 | `rebuild/p0-baseline-list` | p0-e2e-system | open | 0.8 (the list) |
| 12 | #510 | 0 | `rebuild/p0-behaviour-changes` | p0-baseline-list | open | 0.8 (the nine changes) |

Phases 1 to 6 and track A are added here as their PRs are cut.

## Work products

| WP | Item | PR | State |
|---|---|---|---|
| 0.1 | Rulings on the 18 open decisions | none | not done: the human's to make. Each PR built on a recommendation names it under Decisions. |
| 0.2 | `blocks/core/contract.ts` | #496 | open |
| 0.3 | Engine protocol | #502 | open |
| 0.4 | Document type | #497 | open |
| 0.5 | `plugin/base.schema.json` | #499 | open |
| 0.6 | `plugin/credential.schema.json` | #501 | open |
| 0.7 | CLI contract | #503 | open |
| 0.8 | Frozen baseline list, nine changes applied | #509, #510 | open |
| 0.9 | Files panel e2e spec | #507 | open |
| 0.10 | System integration e2e spec | #508 | open |
| 0.11 | Security regression tests by name | #504 | open |
| 0.12 | Renderer bundle carries Effect Schema | #505 | open |
| 0.13 | Throwaway prototype | none | not done: phases 2 and 3 build the same path for real (#510 Gaps) |

## Open decisions built on

Each row names the PR whose description carries the Decisions entry.

| # | Built on (the plan's recommendation) | First PR |
|---|---|---|
| 1 | A headless engine in the core | #496 |
| 2 | Four classes plus five capabilities | #496 |
| 8 | Command and Check outputs declared through an `outputs` prop | #496 |
| 10 | A top-level `blocks/` folder | #496 |
| 11 | A `repository` prop; `gitAuthId` kept | #496 |
| 7 | No click when pins match; confirm when the block pins nothing (`confirmsDetected`) | #501 |
| 12 | MCP baseline is the in-app server's ten tools (`BASELINE_MCP_TOOLS`) | #502 |
| 18 | More than one window left out; the protocol is session-scoped | #502 |
| 13 | CLI named `runbooks`, `runbooks-test` kept as an alias | #503 |
| 3 | Baseline is today's behaviour with the nine ruled changes applied | #509 |
| 5 | `*AuthId` aliases kept with a warning, no removal date; fixtures keep them | #510 |
| 17 | Finish needs a clean success; gh and az still read their own config | #510 |

Choices of my own that need a ruling (not among the 18):

| Choice | PR |
|---|---|
| An expired credential withdraws its env (today it stays published while shown as failed) | #501 |
| `act_on_block` actions with no generic command (GitClone `use_local_checkout`, GitPullRequest `push`/`delete_branch_and_retry`, Iframe, Chapter, Admonition) settled per block in phase 4 | #502 |
| The baseline gate also runs the two step 0 e2e specs (27, not the plan's 25) | #509 |
| `$RUNBOOK_ENV` takes multiline values as `NAME<<DELIMITER` (the plan says only `KEY=VALUE`) | #510 |
| `$RUNBOOK_ENV` may set `PATH`; a block takes it only by naming the writer in `envFrom` | #510 |
| A block whose `envFrom` source has not run is Blocked, as for `dependsOn` | #510 |
| Every block that reads or writes a repository names it, not only pull request blocks on two-repository pages | #510 |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |
