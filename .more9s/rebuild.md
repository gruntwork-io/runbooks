# Runbooks rebuild: stack index

The running index of the rebuild stack. Update it whenever the stack changes.

- Spec: "Runbooks rebuild master plan", https://claude.ai/artifact/8YYhibKcx1Q3HZQGypHNE2 (wins on conflicts),
  and "Runbooks block contract proposal", https://claude.ai/artifact/EEiqpN8kjtoekEV2QX6Qrh (JSON Schema sketch, RFC-188 notes).
- Integration branch: `rebuild/main`, cut from `main` at ac543199 (2026-11-24).
- Every PR is a draft. The bottom PR targets `rebuild/main`; each later PR targets the branch below it.
- Nothing merges and no PR leaves draft without the human.
- **Keep it stacked.** The PRs are GitHub stack #519, based on `rebuild/main` (`gh api repos/gruntwork-io/runbooks/stacks/519`). `.more9s/stack.sh` keeps it that way:
  - `add <branch> <title> <body-file>` opens each new PR as a draft on the top of the stack and links it into #519. Don't open a rebuild PR with `gh pr create` alone.
  - `restack` (`--dry-run` first, in a linked worktree) is needed after any commit to `rebuild/main`, such as an index update, or to a lower branch. It rebases each branch onto the one below and force-pushes it with a lease. CI then reruns on every PR above the change, so batch index updates.
  - `check` exits 1 if a PR's base is not the head below it, or if a head lacks commits its base has.

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
| 10 | #508 | 0 | `rebuild/p0-e2e-system` | p0-e2e-files-panel | green | 0.10 |
| 11 | #509 | 0 | `rebuild/p0-baseline-list` | p0-e2e-system | green | 0.8 (the list) |
| 12 | #510 | 0 | `rebuild/p0-behaviour-changes` | p0-baseline-list | green | 0.8 (the nine changes) |
| 13 | #511 | 1 | `rebuild/p1-packages` | p0-behaviour-changes | green | 1.1 |
| 14 | #512 | 1 | `rebuild/p1-copy-core` | p1-packages | red: GitGuardian only, needs a human (fake secrets in copied tests) | 1.2 |
| 15 | #513 | 1 | `rebuild/p1-registry` | p1-copy-core | green | 1.3 |
| 16 | #514 | 1 | `rebuild/p1-block-id` | p1-registry | green | 1.6 (contract change: `BlockId` normalizes on decode) |
| 17 | #515 | 1 | `rebuild/p1-template-references` | p1-block-id | green | 1.5 |
| 18 | #516 | 1 | `rebuild/p1-document-contract` | p1-template-references | green | contract change for 1.4 (guarded edges, `unknownProp`, `notAllowed`) |
| 19 | #517 | 1 | `rebuild/p1-parse` | p1-document-contract | open | 1.4, part 1: parse, props, ids, errors |
| 20 | #518 | 1 | `rebuild/p1-edge-indices` | p1-parse | open | contract change for 1.4 (edges by block index) |

On 2026-11-24 the human found the PRs were not properly stacked:
- #496 lacked four index commits on `rebuild/main`. Every branch was rebased; trees were unchanged apart from this file.
- The PRs were not linked as a GitHub stack. They now are, with `gh stack link --base rebuild/main 496 … 518` (gh-stack v0.2.0), which created stack #519.

Later phases and track A are added here as their PRs are cut.

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
| 1.1 | Workspace packages with declared exports | #511 | open; `app-main`, `app-renderer` and `blocks` get their tsconfig when they get code |
| 1.2 | Services, layers, shared domain code copied | #512 | open |
| 1.3 | Registry and typed view map | #513 | open |
| 1.4 | `parseRunbook` | #517, #516, #518 | open; still to come: the reference graph, then file hashes and `badFile` |
| 1.5 | The one template-reference extractor | #515 | open |
| 1.6 | The one id comparison | #514 | open |
| 1.7 | Lint rules for blocks | none yet | planned, last PR of phase 1 |

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
| Packages are TypeScript projects with `paths` exports and references, not Bun workspaces (a workspace link makes any import resolve) | #511 |
| `blocks/core` is its own package, `blocks-core`, so `core` can import the contract without a cycle | #511 |
| A domain test that runs against a real layer moves to `platform-node/src/integration/` | #512 |
| The registry is a module of re-exports keyed by tag; `registryProblems` checks name = tag | #513 |
| Only display blocks must have a view; the other classes fall back to their class's view | #513 |
| A view also gets its rendered markdown `children` | #513 |
| The id comparison lives in the `BlockId` schema, so ids compare with `===` | #514 |
| The extractor returns every occurrence; `outputsRead` merges | #515 |
| An unknown prop is a warning, not an error (four baseline fixtures use one) | #516 |
| Shared props apply by class and effects, not per block | #517 |
| `*AuthId` aliases are `envFrom` sources after `envFrom`'s own; code in `parse.ts` (decision 5) | #517 |
| An unknown block is one error per use; a regex prop value is `badProp` | #517 |
| Edges name blocks by index | #518 |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |

## Follow-ups owed

| What | Where it lands |
|---|---|
| knip does not cover the new tree; its declared exports need to be knip entries | the phase 2 PR that first uses `EXIT`, `CLI_ALIASES`, `PROTOCOL_VERSION`, `LIMITS` |
| `app-renderer` may import only the protocol from core: no rule enforces it yet | phase 3, when the package gets code |
| `src/` and its copies in `packages/` drift until the old tree goes | phase 6 |
| GitGuardian incidents 27121678, 33923057, 33923058 re-raised by the copy | the human, in the GitGuardian dashboard |
| Decision 8 (declared outputs): 21 template reads in 9 testdata runbooks use a Command output no `outputs` prop declares, so they fail to load. They need `outputs` patches. | phase 3, with Command (Check in phase 4) |
| The MDXContainer security tests' rendering half (the page shows literal props) | phase 3, with the tree walker |
| `rebuild/main` is cut from main at ac543199; main has moved since | the human: merge main in only if the old tree's fixes must reach the rebuild |
