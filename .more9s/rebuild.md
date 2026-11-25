# Runbooks rebuild: stack index

The running index of the rebuild stack. Update it whenever the stack changes.

- Spec: "Runbooks rebuild master plan", https://claude.ai/artifact/8YYhibKcx1Q3HZQGypHNE2 (wins on conflicts),
  and "Runbooks block contract proposal", https://claude.ai/artifact/EEiqpN8kjtoekEV2QX6Qrh (JSON Schema sketch, RFC-188 notes).
- Integration branch: `rebuild/main`, cut from `main` at ac543199 (2026-11-24).
- The bottom open PR targets `rebuild/main`; each later PR targets the branch below it.
- A PR is marked ready for review once it is green, or red only for a known cause with its fix in progress (the human, 2026-11-25). Only the human merges.
- On 2026-11-25 the human merged #496 to #560 into `rebuild/main`, one commit per PR. The trunk's tree equals the old stack top's (3cd837b5), so open PRs rebase onto it with `git rebase --onto origin/rebuild/main <old base tip>`.
- **Keep it stacked.** The PRs are GitHub stack #519, based on `rebuild/main` (`gh api repos/gruntwork-io/runbooks/stacks/519`). `.more9s/stack.sh` keeps it that way:
  - `add <branch> <title> <body-file>` opens each new PR as a draft on the top of the stack, links it into #519, and waits until GitHub lists it on top (two adds in a row once based the second on the PR below the first). Mark it ready with `gh pr ready` once green. Don't open a rebuild PR with `gh pr create` alone.
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
| `gruntwork-io/runbooks-plugins` | track A Rust sign-in binaries: their own repo, made by the human on 2026-11-24 (empty, public, `main`) | none |
| `baseline/` | frozen baseline list, props, security test names, behaviour-change patches | none |

## Stack

Status: planned, open, green (CI passed on the head), red, merged.
"Green" excludes `Pull Request has non-contributor approval`, which fails on every PR until a human who has not pushed to it approves.

Phase 0 was reordered on 2026-11-24 so dependencies point down the stack: the auth contract owns the credential lifecycle, and the engine protocol carries it.

| # | PR | Phase | Branch | Base | Status | Work products |
|---|---|---|---|---|---|---|
| 1 | #496 | 0 | `rebuild/p0-block-contract` | `rebuild/main` | merged | 0.2 |
| 2 | #497 | 0 | `rebuild/p0-document` | p0-block-contract | merged | 0.4 |
| 3 | #499 | 0 | `rebuild/p0-plugin-transport` | p0-document | merged | 0.5 |
| 4 | #501 | 0 | `rebuild/p0-auth-contract` | p0-plugin-transport | merged | 0.6 |
| 5 | #502 | 0 | `rebuild/p0-engine-protocol` | p0-auth-contract | merged | 0.3 |
| 6 | #503 | 0 | `rebuild/p0-cli-contract` | p0-engine-protocol | merged | 0.7 |
| 7 | #504 | 0 | `rebuild/p0-security-tests` | p0-cli-contract | merged | 0.11 |
| 8 | #505 | 0 | `rebuild/p0-schema-bundle` | p0-security-tests | merged | 0.12 |
| 9 | #507 | 0 | `rebuild/p0-e2e-files-panel` | p0-schema-bundle | merged | 0.9 |
| 10 | #508 | 0 | `rebuild/p0-e2e-system` | p0-e2e-files-panel | merged | 0.10 |
| 11 | #509 | 0 | `rebuild/p0-baseline-list` | p0-e2e-system | merged | 0.8 (the list) |
| 12 | #510 | 0 | `rebuild/p0-behaviour-changes` | p0-baseline-list | merged | 0.8 (the nine changes) |
| 13 | #511 | 1 | `rebuild/p1-packages` | p0-behaviour-changes | merged | 1.1 |
| 14 | #512 | 1 | `rebuild/p1-copy-core` | p1-packages | merged | 1.2 |
| 15 | #513 | 1 | `rebuild/p1-registry` | p1-copy-core | merged | 1.3 |
| 16 | #514 | 1 | `rebuild/p1-block-id` | p1-registry | merged | 1.6 (contract change: `BlockId` normalizes on decode) |
| 17 | #515 | 1 | `rebuild/p1-template-references` | p1-block-id | merged | 1.5 |
| 18 | #516 | 1 | `rebuild/p1-document-contract` | p1-template-references | merged | contract change for 1.4 (guarded edges, `unknownProp`, `notAllowed`) |
| 19 | #517 | 1 | `rebuild/p1-parse` | p1-document-contract | merged | 1.4, part 1: parse, props, ids, errors |
| 20 | #518 | 1 | `rebuild/p1-edge-indices` | p1-parse | merged | contract change for 1.4 (edges by block index; drops the unused `Reference` type) |
| 21 | #521 | 1 | `rebuild/p1-graph` | p1-edge-indices | merged | 1.4, part 2: the reference graph |
| 22 | #522 | 1 | `rebuild/p1-block-errors` | p1-graph | merged | contract change: an error in one block stops that block, not the runbook (`error-scenarios` failed the old contract) |
| 23 | #523 | 1 | `rebuild/p1-files` | p1-block-errors | merged | 1.4, part 3: `loadRunbook`, file hashes, `badFile` |
| 24 | #524 | 1 | `rebuild/p1-edge-source-name` | p1-files | merged | contract change: the template-read edge is tagged `"Output"` (`"Template"` is a block's tag) |
| 25 | #525 | 1 | `rebuild/p1-toy-blocks` | p1-edge-source-name | merged | refactor for 1.7: the core names no block (toy tags, a dead block list) |
| 26 | #526 | 1 | `rebuild/p1-block-lint` | p1-toy-blocks | merged | 1.7; **phase 1's Done when** is in its description |
| 27 | #527 | 2 | `rebuild/p2-refusal-misconfigured` | p1-block-lint | merged | contract change: a misconfigured block's run is refused as `Misconfigured` |
| 28 | #528 | 2 | `rebuild/p2-session` | p2-refusal-misconfigured | merged | 2.1 (sessions, task runs), 2.2 (trust keyed by content hash) |
| 29 | #529 | 2 | `rebuild/p2-plugin-schema-fixes` | p2-session | merged | contract change: plugin schema fixes from the Rust protocol crate |
| 30 | #530 | 2 | `rebuild/p2-field-no-value` | p2-plugin-schema-fixes | merged | contract change: an empty field has no value in the view |
| 31 | #531 | 2 | `rebuild/p2-run-result-submitted` | p2-field-no-value | merged | contract change: a form's submit answers `Submitted` |
| 32 | #532 | 2 | `rebuild/p2-values` | p2-run-result-submitted | merged | 2.1 (form values, submit, review) |
| 33 | #534 | 2 | `rebuild/p2-pretrust-contract` | p2-values | merged | contract change: before-trust functions get no services |
| 34 | #535 | 2 | `rebuild/p2-pretrust` | p2-pretrust-contract | merged | 2.2 (an untrusted session reads the runbook and nothing else) |
| 35 | #536 | 2 | `rebuild/p2-fs-roots-contract` | p2-pretrust | merged | contract change: named roots, open by absolute path |
| 36 | #537 | 2 | `rebuild/p2-fs-roots` | p2-fs-roots-contract | merged | 2.3 |
| 37 | #538 | 2 | `rebuild/p2-env-contract` | p2-fs-roots | merged | contract change: one exit-code table, `envNames` |
| 38 | #539 | 2 | `rebuild/p2-env` | p2-env-contract | merged | 2.4 |
| 39 | #540 | 2 | `rebuild/p2-exit-codes` | p2-env | merged | 2.5 |
| 40 | #541 | 2 | `rebuild/p2-env-event` | p2-exit-codes | merged | contract change: env only through `$RUNBOOK_ENV` |
| 41 | #542 | 2 | `rebuild/p2-run-scope` | p2-env-event | merged | fix: a run's scope ends with the run |
| 42 | #543 | 2 | `rebuild/p2-auth-contract` | p2-run-scope | merged | contract change for 2.6 |
| 43 | #544 | 2 | `rebuild/p2-auth` | p2-auth-contract | merged | 2.6 (detect after trust, credential store, run variables) |
| 44 | #545 | 2 | `rebuild/p2-auth-act` | p2-auth | merged | 2.6 (`ActOnCredential`, sign-out) |
| 45 | #546 | 2 | `rebuild/p2-auth-expiry` | p2-auth-act | merged | 2.6 (expiry, refresh) |
| 46 | #547 | 2 | `rebuild/p2-provider-fit` | p2-auth-expiry | merged | contract change: seven fits the three sign-in binaries found |
| 47 | #548 | 2 | `rebuild/p2-settings-contract` | p2-provider-fit | merged | contract change for 2.7 |
| 48 | #549 | 2 | `rebuild/p2-settings-store` | p2-settings-contract | merged | 2.7 |
| 49 | #550 | 2 | `rebuild/p2-settings-providers` | p2-settings-store | merged | 2.7 (providers get the CA bundle and proxy) |
| 50 | #551 | 2 | `rebuild/p2-settings-import` | p2-settings-providers | merged | 2.7 (first-start import of today's settings files) |
| 51 | #555 | 2 | `rebuild/p2-sessions-contract` | p2-settings-import | merged | contract change for 2.8 |
| 52 | #556 | 2 | `rebuild/p2-sessions-store` | p2-sessions-contract | merged | 2.8 (SQLite database, cipher) |
| 53 | #557 | 2 | `rebuild/p2-sessions-saved` | p2-sessions-store | merged | 2.8 (payload, version, run-log cap) |
| 54 | #558 | 2 | `rebuild/p2-sessions-resume` | p2-sessions-saved | merged | 2.8 (resume) |
| 55 | #559 | 2 | `rebuild/p2-sessions-credentials` | p2-sessions-resume | merged | 2.8 (credential resume) |
| 56 | #560 | 2 | `rebuild/p2-sessions-retention` | p2-sessions-credentials | merged | 2.8 (retention) |
| 57 | #565 | 2 | `rebuild/p2-transport-contract` | `rebuild/main` | open | contract change for 2.9: `Engine.resolveApproval`; a settings watch ends with the store |
| 58 | #566 | 2 | `rebuild/p2-transport` | p2-transport-contract | open | 2.9 |

On 2026-11-24 the human found the PRs were not properly stacked:
- #496 lacked four index commits on `rebuild/main`. Every branch was rebased; trees were unchanged apart from this file.
- The PRs were not linked as a GitHub stack. They now are, with `gh stack link --base rebuild/main 496 … 518` (gh-stack v0.2.0), which created stack #519.

Phase 1 ended with #526 on 2026-11-24. Phase 2 continues with 2.10 and 2.11 (`rebuild/p2-cli-validate`, `p2-test-schema`, `p2-cli-test`, in progress), then Command's definition (its own PR: the registry is empty until phase 3, and phase 2's Done when needs a Command fixture in the test CLI), 2.12 and 2.13; the last carries phase 2's Done when.

## Track A: gruntwork-io/runbooks-plugins

The Rust sign-in binaries, on the gruntwork-io-team/rust-base template, as GitHub stack #9 in that repo. **Since 2026-11-25 a separate `runbooks-plugins` Claude session owns it** (the human's instruction): send it plugin work, contract changes and CI findings; don't push there from this session.

- Stack #9, bottom up: #8 rust-base, #7 google-oauth, #10 to #13 azure, #14 to #18 aws, #19 protocol-fit (merged by the human 2026-11-25), #20 release workflow, #21 and #22 google follow-ups, #23 to #25 azure follow-ups, #26 to #28 aws follow-ups. Unpushed, handed over: `track-a/schema-resume`, `resume-from-values`, `google-tls-error`.
- `schema/credential.schema.json` there must stay byte-identical to `plugin/credential.schema.json` here. A contract change here is sent to that session with its PR number.
- Work product A.5 (`plugins.lock` and the recipes) needs a published plugins release: the human creates the `release` environment (tags `v*`), sets the five `MACOS_*` secrets and pushes a tag. Assets are `<bin>_<ver>_<os>_<arch>[.exe]` plus `SHA256SUMS`.
- A.6 (the hash check): electron-builder re-signs bundled Mach-O binaries, so macOS hashes will not match `plugins.lock` unless `mac.signIgnore` covers them or the hash is checked before packaging.
- Crates approved by the human: serde, serde_json, thiserror, tokio, reqwest (rustls), time, typify, jsonschema and tempfile (dev), aws-config, aws-sdk-sts/sso/ssooidc/iam/account, aws-runtime, aws-types, aws-smithy-http-client, rustls, base64, subtle, libc, windows-sys. Any other direct crate is ask-first; transitive ones are vetted in the PR body.

## Work products

| WP | Item | PR | State |
|---|---|---|---|
| 0.1 | Rulings on the 18 open decisions | none | not done: the human's to make. Each PR built on a recommendation names it under Decisions. |
| 0.2 | `blocks/core/contract.ts` | #496 | merged |
| 0.3 | Engine protocol | #502 | merged |
| 0.4 | Document type | #497 | merged |
| 0.5 | `plugin/base.schema.json` | #499 | merged |
| 0.6 | `plugin/credential.schema.json` | #501 | merged |
| 0.7 | CLI contract | #503 | merged |
| 0.8 | Frozen baseline list, nine changes applied | #509, #510 | merged |
| 0.9 | Files panel e2e spec | #507 | merged |
| 0.10 | System integration e2e spec | #508 | merged |
| 0.11 | Security regression tests by name | #504 | merged |
| 0.12 | Renderer bundle carries Effect Schema | #505 | merged |
| 0.13 | Throwaway prototype | none | not done: phases 2 and 3 build the same path for real (#510 Gaps) |
| 1.1 | Workspace packages with declared exports | #511 | merged; `app-main`, `app-renderer` and `blocks` get their tsconfig when they get code |
| 1.2 | Services, layers, shared domain code copied | #512 | merged |
| 1.3 | Registry and typed view map | #513 | merged |
| 1.4 | `parseRunbook` | #516, #517, #518, #521, #522, #523 | merged |
| 1.5 | The one template-reference extractor | #515 | merged |
| 1.6 | The one id comparison | #514 | merged |
| 1.7 | Lint rules for blocks | #526 (#524, #525 make the tree pass) | merged |
| 2.1 | The session: block states, values, the event log | #528, #532 | merged |
| 2.2 | Trust keyed by content hash; pre-trust marking | #528, #534, #535 | merged |
| 2.3 | Filesystem roots set by the engine | #536, #537 | merged |
| 2.4 | The per-run environment builder | #538, #539 | merged |
| 2.5 | `$RUNBOOK_ENV` and the single exit-code table | #540, #541, #542 | merged |
| 2.6 | The auth lifecycle and the credential store | #543 to #547 | merged |
| 2.7 | The settings store | #548 to #551 | merged |
| 2.8 | The session store | #555 to #560 | merged |
| 2.9 | The in-process transport | #565, #566 | open |
| 2.10 | `runbooks test` and `runbooks validate` | planned | in progress |
| 2.11 | The `runbook_test.yml` schema | planned | in progress |
| 2.12 | The plugin transport owner, tests against a stub binary | planned | not started |
| 2.13 | The credential client, the fake provider, the contract suite | planned | not started |

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
| 9 | `{{ }}` kept in scripts; `env` prop values are used as written, not rendered | #539 |
| 15 | Windows left as it is: environment names compare case-sensitively | #539 |
| 6 | Saved sessions keep form values and credentials, drop run history from older versions | #544 |

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
| Form values are live before submit, and a person's change un-reviews an agent's value (both differ from today) | #532 |
| A malformed `$RUNBOOK_OUTPUT`/`$RUNBOOK_ENV` line fails the run (today it is skipped) | #540 |
| The in-process transport serves one server per client with its origin fixed at creation, and caps no calls in flight | #566 |
| Command's definition lands in phase 2 so phase 2's Done when holds as written; phase 3 adds its view | planned |
| After a restart an AWS SSO or role login comes back as plain keys that cannot refresh: carrying the SSO token needs a secret at rest in `stateDir` (not built) | runbooks-plugins resume follow-up |
| runbooks-plugins keeps rust-base's `unsafe_code = "forbid"`: Azure's process tree uses std plus `/bin/kill` and `taskkill.exe`, not the approved libc/windows-sys FFI; Windows ACLs on `stateDir` wait on the same ruling | runbooks-plugins #24 |
| An unknown block is one error per use; a regex prop value is `badProp` | #517 |
| Edges name blocks by index | #518 |
| `githubAuthId` on a block with its own git-credential prop (GitClone, GitHubPullRequest) is that prop's alias, not an `envFrom` source | #517 |
| A cycle is one error per set of blocks that wait for each other, at its first block, naming the shortest loop | #521 |
| `syntax`, `notAllowed`, `unknownBlock`, `versionRequired` refuse the runbook; every other error stops its block (`Misconfigured`), and the second of two blocks with one id is the misconfigured one | #522 |
| Parsing takes two steps so the loader reads only the files blocks name; a missing or outside file is `badFile` at its prop; a folder hashes as `hashTemplateDir` | #523 |
| The block-name lint counts the baseline's 21 blocks before they land, counts code (a string equal to a tag or holding `<Tag`, a key, element or export) and not comments or imported names, and covers the packages only | #526 |
| A `views.ts` entry is one line naming its folder | #526 |

## Failed attempts

| Check | Attempt | Result |
|---|---|---|
| Generate TS from `plugin/base.schema.json` | `not: { required: [id] }` on notifications | Effect's importer: "Cannot import JSON Schema keyword \"not\"". Rule moved to the transport owner (#499). |

## Follow-ups owed

| What | Where it lands |
|---|---|
| knip does not cover the new tree; its declared exports need to be knip entries | 2.10 (`rebuild/p2-cli-validate`, in progress) for `EXIT` and `CLI_ALIASES`; 2.12 for `PROTOCOL_VERSION` and `LIMITS` |
| `app-renderer` may import only the protocol from core: no rule enforces it yet | phase 3, when the package gets code |
| `src/` and its copies in `packages/` drift until the old tree goes | phase 6 |
| GitGuardian incidents 27121678, 33923057, 33923058 re-raised by the copy | the human, in the GitGuardian dashboard |
| Decision 8 (declared outputs): 21 template reads in 9 testdata runbooks use a Command output no `outputs` prop declares, so they fail to load. They need `outputs` patches. | phase 3, with Command (Check in phase 4) |
| The MDXContainer security tests' rendering half (the page shows literal props) | phase 3, with the tree walker |
| `rebuild/main` is cut from main at ac543199; main has moved since | the human: merge main in only if the old tree's fixes must reach the rebuild |
| `error-scenarios` expects `config_error` per step: the test CLI maps `Misconfigured` to it (#522) | 2.10 (`rebuild/p2-cli-test`, in progress) |
| A block's errors show in place of its view (#522) | phase 3, the renderer |
| `showWhenBlock`'s target check becomes a `run`-capability reference on Command, Check and Finish (#525 removed the old type list) | phases 3 and 4 |
| `<Iframe>` passes the literal-only check: a test in the Iframe block's folder (#525 moved the core's case to `<Script>`) | phase 4, Iframe |
| No size limit on a file a block names; it is read whole to hash it (#523) | before phase 6 |
| The block-name lint reads `baseline/props.json`; when the baseline retires, the registry alone names the blocks (#526) | phase 6 |
| `TaskInput.values` hands sensitive form values in clear: make them `Redacted` entries or a secrets map | phase 3, before the phase 4 fan-out |
| `BlockView` and `SessionView` carry node errors (parse and engine-found); `FieldView` needs `section` and `optionLabels` | phase 3 |
| Where a form block's output values come from (the engine uses the same-name field, wrong for DirPicker and Iframe) | phase 3 |
| A block waits for each input its template references (today, #489); a referenced optional field with no default runs with an empty string | phase 3, Command |
| A run gets the hashed script texts instead of re-reading them; `instruction()` input needs an I/O-free build | phase 3, Command (contract change) |
| A plugin-backed form needs a read after trust (Layer 3 against the trust rule) | phase 4 (contract change) |
| A person-picked checkout root, and Template targets in it | phase 4 |
| The CLI resolves relative paths before `OpenSession`; `NodeSessionDatabase` is first wired by an entry point (moved from 2.9) | 2.10 |
| `SetValues` payload (keys, value size) uncapped; a malformed payload from an untyped caller is untested | phase 3, MCP (the first untyped caller) |
| A `LogLines` event holds up to 10,000 lines and no line length is capped; the transport's stream buffer counts events | phase 3, with the IPC transport |
| A parse-time `envConflict` for overlapping `envNames`; `ProviderInfo.names` within `envNames` | 2.13 |
| The base environment's `PATH` is not refreshed; the heredoc advice in the docs (plan item 615) | phase 5 |
| `baseline/security-tests.ts`: two tests renamed in phase 2 | phase 6 |
| The credential contract does not describe `proxy`, `caBundleFile` or a no-proxy list; AWS and Google ignore the environment's proxy variables, Azure's `az` inherits them | a contract change, then runbooks-plugins |
