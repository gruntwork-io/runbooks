/**
 * The security regression tests the rebuild must carry, by name. Each guard
 * lists today's tests word for word. The new tree ports each test under the
 * same name, at the place `portsTo` names; the baseline gate (phase 6)
 * fails while any is missing there.
 *
 * `security-tests.test.ts` checks that every name below still exists in
 * today's tree, so the list cannot drift before the port.
 */

export interface Guard {
  /** What the guard stops. */
  readonly guard: string
  /** The fix that added it. */
  readonly fix: string
  /** Where the new tree holds the code the tests exercise. */
  readonly portsTo: string
  readonly tests: ReadonlyArray<{ readonly file: string; readonly names: ReadonlyArray<string> }>
}

export const SECURITY_TESTS: ReadonlyArray<Guard> = [
  {
    guard:
      "Script environment allowlist: a run gets only the variables a credential block passes; no caller sets PATH, BASH_ENV, LD_PRELOAD or a runbook-managed variable",
    fix: "#376 (f24016c6), #378 (10f63e95)",
    portsTo: "phase 2: the per-run environment builder in packages/core",
    tests: [
      {
        file: "src/domain/exec/executor.test.ts",
        names: [
          "refuses names no auth block passes, before creating or spawning anything",
          "passes every auth block's vars over the session's",
        ],
      },
      {
        file: "src/domain/exec/blockEnv.test.ts",
        names: [
          "refuses a name a shell can't export",
          "refuses the names Runbooks sets for every run",
          "quotes each value so a shell sets it exactly, running nothing",
        ],
      },
      {
        file: "electron/main/ipc/session.test.ts",
        names: ["session:set-env refuses a var an <AwsAuth> block doesn't write, and sets nothing"],
      },
      {
        file: "electron/main/ipc/session-env.test.ts",
        names: [
          "refuses an override that isn't an auth block's, and runs nothing",
          "strips inherited AWS credentials for a runbook with <AwsAuth>, and only for it",
          "does not write a run's block-scoped env overrides into the session",
        ],
      },
    ],
  },
  {
    guard:
      "Path guard: no read, write, clone or served asset reaches outside its root, through `..`, a symlink, percent-encoding or a cycle",
    fix: "#160 (aab30b51), #205 (c97770d7), #207 (d2492366)",
    portsTo:
      "phase 2: the filesystem roots the engine sets, in packages/core, with the containment helpers in packages/platform-node",
    tests: [
      {
        file: "src/path-validation.test.ts",
        names: [
          "detects Windows-style backslash traversal",
          "returns false for prefix-but-not-parent",
          "rejects a path that escapes via a symlink to an existing outside target",
          "rejects a write through a dangling symlink that points outside",
          "rejects a relative dangling symlink reached through a directory symlink",
          "rejects a dangling symlink whose target has `..` after a directory symlink",
          "rejects an input path with `..` after a directory symlink that points outside",
          "rejects a symlink reached after `..` pops a not-yet-existing segment",
          "rejects an input path whose `..` escapes only once collapsed lexically",
          "fails closed on a symlink cycle",
        ],
      },
      {
        file: "electron/main/ipc/path-guard.test.ts",
        names: [
          "rejects a path in the session that is a symlink to outside it",
          "rejects the working directory's absolute path",
          "rejects a destination reached through a symlink that points outside",
          "rejects a destination outside the working directory",
          "refuses another runbook's host",
          "refuses a symlink that points outside the runbook directory",
          "refuses an outside symlink named with percent-encoding",
          "refuses traversal, including percent-encoded separators",
          "refuses malformed percent-encoding",
          "refuses files in the runbook directory outside assets/",
          "refuses everything when assets/ is a symlink out of the runbook directory",
        ],
      },
    ],
  },
  {
    guard:
      "GitClone git config: a repository's own config (core.fsmonitor and the like) never runs a command in Runbooks' git, and a bare-looking directory is never taken for a repository",
    fix: "#474 (03e804d6)",
    portsTo: "phase 1: the git layer copied into packages/platform-node; phase 4: blocks/git-clone",
    tests: [
      {
        file: "src/domain/git/env.test.ts",
        names: [
          "turns off the settings that let a repository's own config run a command",
          "adds them after config the environment already passes, so they win over it",
          "does not run the command a repository's core.fsmonitor names",
          "does not take a plain directory of repository files for a repository",
        ],
      },
      {
        file: "src/domain/git/local-repo.test.ts",
        names: [
          "refuses a selected directory that looks like a bare repository, before running git there",
          "refuses a subdirectory of a bare-looking directory that git would reach before a .git",
          "refuses a git too old to take config from the environment",
          "refuses a git whose version it can't read",
        ],
      },
    ],
  },
  {
    guard:
      "Git tokens: a token never lands in .git/config, a remote URL or another origin, and a URL or branch name is never taken as a git option",
    fix: "#205 (c97770d7)",
    portsTo: "phase 1: the git layer in packages/platform-node; phase 4: blocks/git-auth",
    tests: [
      {
        file: "src/layers/GitCliClient.test.ts",
        names: [
          "never lets a clone's URL act as a git option",
          "push takes an option-like branch as a refspec and never runs it",
          "clones with the token without writing it into the checkout's origin URL",
          "does not send the token to a push URL on another origin",
          "never hands a rejected token's fallback to the user's credential helper",
          "strips a token embedded in the origin URL from getInfo and getRemoteUrl",
        ],
      },
      {
        file: "src/domain/git/local-repo.test.ts",
        names: ["never returns a token embedded in the remote URL"],
      },
    ],
  },
  {
    guard: "Opening a runbook runs none of its code: MDX is literal only",
    fix: "#206 (db292ec5)",
    portsTo: "phase 1: parseRunbook in packages/core",
    tests: [
      {
        file: "src/remarkLiteralOnly.test.ts",
        names: [
          "rejects anything that runs JavaScript",
          "names the line, prop and block in the error",
        ],
      },
      {
        file: "web/src/components/__tests__/MDXContainer.security.test.tsx",
        names: [
          "MDXContainer — runbook code cannot run on open",
          "rejects %s and never calls the API",
          "still renders literal props, comments and template strings",
        ],
      },
    ],
  },
  {
    guard: "Template values and keys never run a command",
    fix: "#376 (f24016c6)",
    portsTo: "phase 4: blocks/template and blocks/template-inline",
    tests: [
      {
        file: "src/domain/boilerplate/flattenInputs.test.ts",
        names: [
          "strips entries whose key is a template, at any depth",
          "never passes a map key that is still a template to the var file",
        ],
      },
      {
        file: "src/layers/WasmBoilerplate.test.ts",
        names: ["turns the CLI's shell helper off for a var file with a shell call in it"],
      },
    ],
  },
]
