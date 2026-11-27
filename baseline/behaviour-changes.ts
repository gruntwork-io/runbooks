/**
 * The twelve behaviour changes the rulings make (nine on 2026-11-23, open
 * decision 9's, the refused `<style>` of 2026-11-26, and watch mode's
 * `--disable-live-file-reload` of 2026-11-27), applied to the
 * baseline fixtures and e2e specs that rely on the old behaviour. Each
 * patch in `behaviour-changes/` rewrites one fixture or spec. Today's app
 * still runs the originals, so the patches stay out of the tree until the
 * new tree runs them: `git apply baseline/behaviour-changes/*.patch`.
 *
 * `behaviour-changes.test.ts` checks that every patch still applies to
 * today's tree, so a later change to a fixture cannot leave its patch stale.
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export const PATCH_DIR = path.resolve(import.meta.dir, "behaviour-changes")

export type BehaviourChange =
  | "envFrom"
  | "runbookEnv"
  | "cd"
  | "exitTwo"
  | "ambientCredentials"
  | "generateButton"
  | "generateFileFalse"
  | "badReference"
  | "repository"
  | "scriptTemplates"
  | "metadataElements"
  | "inlineCommandReloads"

interface Change {
  readonly before: string
  readonly after: string
  /** Why no fixture or spec relies on the old behaviour, and what tests the new one. */
  readonly unpinned?: string
}

/** The plan's "What an author will notice" table, one entry per row, and the rulings since. */
export const CHANGES: Record<BehaviourChange, Change> = {
  envFrom: {
    before: "Five *AuthId props name credentials",
    after: "One ordered envFrom. The old props work, with a warning.",
    unpinned:
      "The *AuthId props keep working, so no fixture relies on their being the only way. Fixtures that use them exercise the aliases (open decision 5). The patches use envFrom with task sources; a credential source in envFrom first gets a fixture with its block in phase 4.",
  },
  runbookEnv: {
    before: "export in bash persists",
    after: "Write KEY=VALUE to $RUNBOOK_ENV",
  },
  cd: {
    before: "cd in a script persists into later blocks",
    after: "Does not persist",
  },
  exitTwo: {
    before: "A Command exiting 2 is shown as a failure",
    after: "A warning that publishes outputs",
    unpinned:
      "No fixture has a Command that exits 2. The Checks that do already expect warn. The engine's exit-code table (phase 2, work product 2.5) tests it for every task.",
  },
  ambientCredentials: {
    before: "Ambient credential variables are loaded into every script",
    after: "Stripped unless a credential block is named",
    unpinned:
      "The fixtures' tests already blank the credential variables they care about, and the runs that read credentials without naming a block use gh or az, which read their own config files (open decision 17), and are skipped in tests. The per-run environment builder (phase 2, work product 2.4) tests the stripping.",
  },
  generateButton: {
    before: "TemplateInline with generateFile writes on mount",
    after: "Writes after a click on Generate",
  },
  generateFileFalse: {
    before: 'generateFile="false" writes the file',
    after: "Does not",
    unpinned:
      'No fixture writes generateFile="false". The TemplateInline block (phase 4) tests it.',
  },
  badReference: {
    before: 'A mistyped block reference waits ("Waiting for…") forever',
    after: "A configuration error with the line",
    unpinned:
      "No fixture has a mistyped reference. parseRunbook (phase 1, work product 1.4) tests it; the document contract's tests already state it.",
  },
  repository: {
    before: 'A pull request block on a page with two repositories uses the "active" one',
    after: "Must name its repository",
    /**
     * The patches go one step further: every block that reads or writes a
     * repository names it, since the plan's environment section has no
     * "active" repository for any block.
     */
  },
  scriptTemplates: {
    before: "A script's {{ .inputs.X }} and {{ .outputs.B.K }} are filled in before it runs",
    after: "The script runs as written; a value reaches it only through the block's env",
  },
  /**
   * A runbook's `<style>` applies to the whole window, and today's CSP allows
   * inline styles, so one can hide the trust banner. `<meta>`, `<base>` and
   * `<link>` hand the window another document to load.
   */
  metadataElements: {
    before: "A runbook's <style>, <link>, <meta> and <base> reach the window",
    after: "A configuration error; restyle an element with its style prop",
    unpinned:
      "No fixture or spec's runbook has one. The only hits are pages a frame loads (testdata/feature-demos/iframe/assets, and iframe.spec.ts's LOCAL_PAGE), not runbooks. packages/core/src/document/security.test.ts tests each refusal.",
  },
  /**
   * Ruled 2026-11-27 ("Only script files"). A session holds one document,
   * and the window draws it, so what a block shows is what it runs.
   */
  inlineCommandReloads: {
    before:
      "With --watch --disable-live-file-reload, a reload shows an edited inline command but runs the one opened",
    after: "Runs the edited one; only script files keep their text until reloaded from their block",
  },
}

/** Each patch, by file name in `behaviour-changes/`, and the changes it applies. */
export const PATCHES: Record<string, ReadonlyArray<BehaviourChange>> = {
  "runbook-execution-model.patch": ["runbookEnv", "cd"],
  "prerequisites.patch": ["runbookEnv"],
  "finish.patch": ["runbookEnv"],
  "run-order.patch": ["runbookEnv"],
  "show-when-block.patch": ["runbookEnv"],
  "dual-clone.patch": ["cd"],
  "file-workspace.patch": ["repository"],
  "github-pull-request.patch": ["repository"],
  "next-app.patch": ["repository"],
  "e2e-execution-flow.patch": ["runbookEnv", "cd"],
  "e2e-kitchen-sink.patch": ["generateButton"],
  "e2e-sessions.patch": ["runbookEnv", "cd", "scriptTemplates"],
  "e2e-concurrent-runs.patch": ["scriptTemplates"],
  "e2e-files-panel.patch": ["generateButton", "repository"],
  "e2e-watch-mode.patch": ["inlineCommandReloads"],
}

/** The patch files on disk. */
export function patchFiles(): string[] {
  return readdirSync(PATCH_DIR)
    .filter((f) => f.endsWith(".patch"))
    .sort((a, b) => a.localeCompare(b))
}

/** The files a patch changes, from its `diff --git a/<path> b/<path>` lines. */
export function filesIn(patch: string): string[] {
  const text = readFileSync(path.join(PATCH_DIR, patch), "utf8")
  return [...text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]!)
}
