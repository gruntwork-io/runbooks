# Draft: WP 2.10 + 2.11, `runbooks validate`, the runbook_test.yml schema, `runbooks test` (not committed)

Goal: one `runbooks` binary, engine in process through the in-process client, validates a runbook
without running anything and tests it against its runbook_test.yml.

Stated size: 3 branches stacked on rebuild/p2-transport (a2e460b2, #566):
1. rebuild/p2-cli-validate (PR 33): entry point (main.ts), validate, path discovery, knip covers new tree.
2. rebuild/p2-test-schema (PR 34): registry-derived Effect Schema for runbook_test.yml, YAML loader with
   lines, committed JSON Schema + drift test, fixture check over testdata/ with a baseline stand-in registry.
3. rebuild/p2-cli-test (PR 35): runner over makeInProcessClient, reporters text/junit/json, Ctrl-C, isolation.
~15 files, ~3500 lines with tests.

Values/standards read: all values but explain-the-number/reproduce/attack-the-premise; standards all but
vet-new-dependencies; report.md, existing-repos.md, playbooks contract-first/open-a-pr/maintain-a-stack;
typescript-best-practices.

## Survey facts
- effect 4.1.2; effect/cli needs FileSystem|Path|Terminal|ChildProcessSpawner|Stdio (effect's), no
  @effect/platform-node in bun.lock -> Node Stdio/Terminal layer goes in platform-node.
- Engine resumes `store.latest(file)`: CLI uses a store that keeps nothing (no resume across test cases).
- Engine has no showWhenBlock (hidden never produced), no block errors in BlockView (CLI uses loaded doc).
- Credential: no providers -> open fails providerFailed -> Unavailable -> Failed status.
- knip probe: with declared exports as entries, findings = platform-node AppLayer/NodeWasmRuntime (no
  declared exports), plugin/transport PROTOCOL_VERSION/LIMITS (core plugin/ not declared), CLI_ALIASES TBD.
- testdata: 37 runbook_test.yml; keys used: settings{timeout,use_temp_working_dir,parallelizable},
  test{name,description,env,inputs,steps,assertions}, step{block,expect,env_prefix,error_contains,
  missing_outputs,set_outputs,assertions}; missing_outputs only with blocked, error_contains only with
  config_error; GitHubPullRequest only skip; GitClone success x2 (so GitClone must not be external).

## Decisions
- B1 contract: CliFailure + Unreadable{path,message}, TooManyFiles{path,limit} (8e2963c0). Why: a runbook that exists but cannot be read, and the `/...` walk cap, had no failure to name them.
- B1 knip: entries = every tsconfig.packages.json path target (`*` read as `**/*`, as TS matches across folders) + `packages/cli/src/main.ts` + the two contracts for non-TS programs (cli contract: scripts/CI; plugin transport: plugin binaries). Test in scripts/packages.test.ts. Closes EXIT/CLI_ALIASES now and PROTOCOL_VERSION/LIMITS early (map said 2.12).
- B1 platform-node declares `@runbooks/platform-node/layers/*` (cli is its first importer; AppLayer/NodeWasmRuntime were unused files to knip without it).
- B1 version: Bun macro `appVersion.ts` reads root package.json at transpile time; lint forbids relative import out of packages and packages test forbids a non-package path key.
- B1 effect/cli env: NodeCliEnvironment layer in platform-node (no @effect/platform-node in lock). Parser FileSystem = layerNoop, ChildProcessSpawner dies naming itself.
- B1 stdout only data: requested help + version on stdout; refused command line help + errors on stderr; json requested -> BadFlag report on stdout.
- B1 open/mcp: registered by contract, fail "not built yet" + EXIT.failure. test: same until branch 3.
- B1 walk: skips node_modules and dot folders; cap 20_000 entries per `/...`; sorted; dedupe across patterns; first path naming nothing fails fast (old CLI did same? check).
- B1 docs: no rebuild PR touches docs/; phase 6 owns docs. Listed in Gaps.

## Failed attempts
- `import packageJson from "../../../package.json"` in main.ts: refused by runbooks(no-relative-import-across-packages).
- B2 schema: two layers from one KIND_RULES table: the format (TestFile, closed keys) and the binding to the runbook (boundTestFile(targetsOf(document, registry))). External = declares push, or a plugin level beyond read (plan line 198). Unknown step block left to run and fail (docs line 124). error_contains needs config_error, missing_outputs needs blocked (newly enforced; today only used that way). Undocumented step `outputs` dropped. Null list keys accepted (6 fixtures). inputs id must take answers; field names unchecked statically.
- B2 JSON Schema generated on demand (`bun packages/cli/src/writeTestFileSchema.ts`), not committed; drift test is behavioural (fixtures + FULL accepted by both; 14 refusals agree), not golden.
- B2 stand-in registry of 21 tags in baseline/ (lint rule applies only in packages); `@runbooks/cli/testFile` declared for it. 3 fixtures fail on GitClone push (plan 71/289/318 vs fixtures).
- B3 contract: CliFailure + Cancelled (cd47a0e1): Ctrl-C had no failure to say the run was stopped.
- B3 origin person (CLI = person per protocol; only a person trusts). Engine per test case via core `serveEngine(options)` (Engine not exported, per transport PR decision 6). Temp folder per test case (working + state), removed in a finalizer.
- B3 isolation: NoSavedSessions (nodeSessionDatabase not wired: CLI keeps nothing), DefaultSettings (no file), NoCredentialProviders (providerFailed -> Failed -> step actual fail).
- B3 load all first: a bad test file stops before anything runs (BadTestFile). Runbook that does not open: its errors in the report, each test case failed.
- B3 Ctrl-C: Deferred `stop`; settle races WaitForBlock with it, then CancelBlock + WaitForBlock (10 s); later test cases skipped; failure Cancelled; exit 1. main.ts listens once, so a second Ctrl-C kills.
- B3 --max-parallel works: Effect.forEach concurrency; parallelizable: false after, alone. Report in path order.
- B3 not built (test fails, never passes): fuzz inputs, script assertions, cleanup, working_dir / use_temp_working_dir false / output_path other than generated, expect hidden (no showWhenBlock).
- B3 --output-file unwritable: report to stdout, error to stderr, exit by the tests.

## Failed attempts (B3)
- First output-file test assumed exit 1 on an unwritable file; kept exit by test outcome (contract EXIT lists no such failure) and fixed the test.
- First isolation test checked `<runbook>/generated` only; a workingFolders mutation wrote `<runbook>/<session>/generated` and passed it. Now compares a recursive listing.
