/**
 * The frozen baseline: what the rebuilt app must still do. Open decision 3,
 * built as recommended: today's behaviour, with the nine ruled changes
 * applied to the fixtures and specs that rely on the old behaviour
 * (`behaviour-changes.ts`). Under the alternative, today's behaviour
 * exactly, that file and its patches go.
 *
 * The baseline gate (phase 6) runs every fixture and e2e spec here on the
 * new tree, checks every frozen prop against the registry, and serves every
 * MCP tool. Until then `baseline.test.ts` checks each entry against today's
 * tree, so nothing is dropped from it unnoticed.
 */

/** The 21 MDX tags and their props, as their docs pages list them: `props.json`. */
export const PROPS_FILE = "baseline/props.json"

/** The `runbook_test.yml` format, as documented and as today's test CLI parses it. */
export const RUNBOOK_TEST_YML = {
  docs: "docs/src/content/docs/authoring/testing.mdx",
  parser: "cli/test/config.ts",
  expect: ["success", "fail", "warn", "blocked", "skip", "hidden", "config_error"],
  assertions: [
    "file_exists",
    "file_not_exists",
    "file_contains",
    "file_not_contains",
    "file_matches",
    "file_equals",
    "output_equals",
    "output_matches",
    "output_exists",
    "files_generated",
    "script",
    "dir_exists",
    "dir_not_exists",
  ],
} as const

/**
 * The MCP tools: the in-app server's ten (open decision 12). The engine
 * protocol maps each to a command in `BASELINE_MCP_TOOLS`.
 */
export const MCP_TOOLS_SOURCE = "electron/main/agent/tools.ts"

/** Every runbook fixture, by its `runbook_test.yml`. */
export const FIXTURES = [
  "testdata/feature-demos/admonition/runbook_test.yml",
  "testdata/feature-demos/auto-collapse/runbook_test.yml",
  "testdata/feature-demos/aws-auth/runbook_test.yml",
  "testdata/feature-demos/azure-auth/runbook_test.yml",
  "testdata/feature-demos/block-outputs/runbook_test.yml",
  "testdata/feature-demos/chapters/runbook_test.yml",
  "testdata/feature-demos/conditional-fields/runbook_test.yml",
  "testdata/feature-demos/file-workspace/runbook_test.yml",
  "testdata/feature-demos/finish/runbook_test.yml",
  "testdata/feature-demos/form-layout/runbook_test.yml",
  "testdata/feature-demos/git-auth/runbook_test.yml",
  "testdata/feature-demos/git-clone/runbook_test.yml",
  "testdata/feature-demos/github-auth/runbook_test.yml",
  "testdata/feature-demos/github-pull-request/runbook_test.yml",
  "testdata/feature-demos/google-auth/runbook_test.yml",
  "testdata/feature-demos/iframe/runbook_test.yml",
  "testdata/feature-demos/inputs-and-outputs/runbook_test.yml",
  "testdata/feature-demos/output-options/runbook_test.yml",
  "testdata/feature-demos/prerequisites/runbook_test.yml",
  "testdata/feature-demos/pseudo-tty/runbook_test.yml",
  "testdata/feature-demos/run-order/runbook_test.yml",
  "testdata/feature-demos/runbook-execution-model/runbook_test.yml",
  "testdata/feature-demos/runbook-testing/runbook_test.yml",
  "testdata/feature-demos/script-env/runbook_test.yml",
  "testdata/feature-demos/script-logging/runbook_test.yml",
  "testdata/feature-demos/show-when-block/runbook_test.yml",
  "testdata/feature-demos/template-defaults/runbook_test.yml",
  "testdata/sample-runbooks/demo1/runbook_test.yml",
  "testdata/sample-runbooks/demo2/runbook_test.yml",
  "testdata/sample-runbooks/demo3/runbook_test.yml",
  "testdata/sample-runbooks/dual-clone/runbook_test.yml",
  "testdata/sample-runbooks/error-scenarios/runbook_test.yml",
  "testdata/sample-runbooks/homepage-demo/runbook_test.yml",
  "testdata/sample-runbooks/lambda/runbook_test.yml",
  "testdata/sample-runbooks/markdown-only-full/runbook_test.yml",
  "testdata/sample-runbooks/my-first-runbook/runbook_test.yml",
  "testdata/sample-runbooks/next-app/runbook_test.yml",
] as const

/** Today's e2e specs. */
export const E2E_SPECS = [
  "electron/e2e/agent-access.spec.ts",
  "electron/e2e/command-palette.spec.ts",
  "electron/e2e/concurrent-runs.spec.ts",
  "electron/e2e/custom-ca.spec.ts",
  "electron/e2e/electron.spec.ts",
  "electron/e2e/execution-flow.spec.ts",
  "electron/e2e/find-in-page.spec.ts",
  "electron/e2e/iframe-messaging.spec.ts",
  "electron/e2e/iframe.spec.ts",
  "electron/e2e/kitchen-sink.spec.ts",
  "electron/e2e/long-paths.spec.ts",
  "electron/e2e/runbook-assets.spec.ts",
  "electron/e2e/runbook-scrollbar.spec.ts",
  "electron/e2e/sessions.spec.ts",
  "electron/e2e/theme.spec.ts",
  "electron/e2e/vcs-auth.spec.ts",
  "electron/e2e/watch-mode.spec.ts",
  "web/e2e/admonition.spec.ts",
  "web/e2e/chapters.spec.ts",
  "web/e2e/instruction-mode.spec.ts",
  "web/e2e/prerequisites.spec.ts",
  "web/e2e/resize-runbook.spec.ts",
  "web/e2e/script-env.spec.ts",
  "web/e2e/template-defaults.spec.ts",
  "web/e2e/test-sample-runbooks.spec.ts",
] as const

/**
 * The e2e specs step 0 writes against today's app for the files panel and
 * system integration, so their rebuilds have something to pass.
 */
export const STEP_0_E2E_SPECS = [
  "electron/e2e/files-panel.spec.ts",
  "electron/e2e/system.spec.ts",
] as const
