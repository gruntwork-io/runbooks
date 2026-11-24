# Runbooks rebuild: stack index

The running index of the rebuild stack. Update it whenever the stack changes.

- Spec: "Runbooks rebuild master plan", https://claude.ai/artifact/8YYhibKcx1Q3HZQGypHNE2 (wins on conflicts),
  and "Runbooks block contract proposal", https://claude.ai/artifact/EEiqpN8kjtoekEV2QX6Qrh (JSON Schema sketch, RFC-188 notes).
- Integration branch: `rebuild/main`, cut from `main` at ac543199 (2026-11-24).
- Every PR is a draft. The bottom PR targets `rebuild/main`; each later PR targets the branch below it.
- Nothing merges and no PR leaves draft without the human.

## Finish line

The top of the stack passes, in CI:

- all 37 runbook fixtures (the frozen baseline copies) through the new `runbooks test`;
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
| `baseline/` | frozen baseline list and fixture copies | none |

## Stack

Status: planned, open (draft PR open), green (CI passed on the head), red.
"Green" excludes `Pull Request has non-contributor approval`, which fails on every PR until a human who has not pushed to it approves.

Phase 0 was reordered on 2026-11-24 so dependencies point down the stack: the auth contract owns the credential lifecycle, and the engine protocol carries it.

| # | PR | Phase | Branch | Base | Status | Work products |
|---|---|---|---|---|---|---|
| 1 | #496 | 0 | `rebuild/p0-block-contract` | `rebuild/main` | green | 0.2 |
| 2 | #497 | 0 | `rebuild/p0-document` | p0-block-contract | green | 0.4 |
| 3 | #499 | 0 | `rebuild/p0-plugin-transport` | p0-document | open | 0.5 |
| 4 | #501 | 0 | `rebuild/p0-auth-contract` | p0-plugin-transport | open | 0.6 |
| 5 | #502 | 0 | `rebuild/p0-engine-protocol` | p0-auth-contract | open | 0.3 |
| 6 | | 0 | `rebuild/p0-cli-contract` | p0-engine-protocol | planned | 0.7 |
| 7 | | 0 | `rebuild/p0-security-tests` | p0-cli-contract | planned | 0.11 |
| 8 | | 0 | `rebuild/p0-e2e-files-panel` | p0-security-tests | planned | 0.9 |
| 9 | | 0 | `rebuild/p0-e2e-system` | p0-e2e-files-panel | planned | 0.10 |
| 10 | | 0 | `rebuild/p0-schema-bundle` | p0-e2e-system | planned | 0.12 |
| 11 | | 0 | `rebuild/p0-baseline` | p0-schema-bundle | planned | 0.8 |

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
| 0.13 | Throwaway prototype | none | see Gaps once decided |

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

Choices of my own that need a ruling (not among the 18):

| Choice | PR |
|---|---|
| An expired credential withdraws its env (today it stays published while shown as failed) | #501 |
| `act_on_block` actions with no generic command (GitClone `use_local_checkout`, GitPullRequest `push`/`delete_branch_and_retry`, Iframe, Chapter, Admonition) settled per block in phase 4 | #502 |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |
