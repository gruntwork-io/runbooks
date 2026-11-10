/**
 * The command line of control-runbooks: which commands exist, what each
 * takes, and turning argv into one command with its target. Pure, so the
 * parsing and its error messages are tested without an app running.
 */

export interface Target {
  readonly role?: string | undefined
  readonly name?: string | undefined
  readonly label?: string | undefined
  readonly text?: string | undefined
  readonly testid?: string | undefined
  readonly css?: string | undefined
  /** A block's id (its data-testid) that scopes the search. */
  readonly within?: string | undefined
  readonly nth?: number | undefined
  readonly exact: boolean
}

export interface Parsed {
  readonly command: string
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | true>>
  readonly target: Target | undefined
}

interface FlagSpec {
  readonly name: string
  readonly value?: string
  readonly help: string
}

export interface CommandSpec {
  readonly name: string
  readonly usage: string
  readonly summary: string
  readonly example: string
  readonly flags: readonly FlagSpec[]
  /** Whether the command acts on an element named by the target flags. */
  readonly targeted?: boolean
  /** Whether the command changes the app, so it captures evidence and takes --dry-run. */
  readonly acts?: boolean
}

const TARGET_FLAGS: readonly FlagSpec[] = [
  { name: "role", value: "role", help: "ARIA role, such as button, tab, textbox, treeitem" },
  { name: "name", value: "text", help: "accessible name (with --role); substring unless --exact" },
  { name: "label", value: "text", help: "a form field by its label" },
  { name: "text", value: "text", help: "an element by its visible text" },
  { name: "testid", value: "id", help: "an element by data-testid" },
  { name: "css", value: "selector", help: "escape hatch: a CSS selector" },
  { name: "within", value: "block-id", help: "search only inside this block (its data-testid)" },
  { name: "nth", value: "n", help: "pick the nth match (0-based) when several match" },
  { name: "exact", help: "match --name, --label or --text exactly" },
]

const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "instance", value: "name", help: "which running app to drive (default: default)" },
  { name: "help", help: "show this command's help" },
]

const ACT_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", help: "resolve the target and report what would happen, without acting" },
  { name: "settle", value: "ms", help: "wait this long after acting before the screenshot (400)" },
]

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "up",
    usage: "up <runbook-path> [--simulate] [--real-home] [--no-build]",
    summary: "Build if stale, launch the app on a runbook, and wait until it's usable",
    example: "control-runbooks up testdata/feature-demos/tf-module --simulate",
    flags: [
      {
        name: "simulate",
        help: "open with --simulate, so simulation.yml answers lookups and runs",
      },
      { name: "real-home", help: "keep your HOME, so saved GitHub and cloud sign-ins apply" },
      { name: "no-build", help: "launch dist/ as it is, even when sources are newer" },
    ],
  },
  {
    name: "doctor",
    usage: "doctor",
    summary: "Read-only check: is the instance up, reachable, current, and on the right runbook?",
    example: "control-runbooks doctor",
    flags: [],
  },
  {
    name: "down",
    usage: "down [--dry-run]",
    summary: "Stop the app this tool started and remove its scratch state; evidence stays",
    example: "control-runbooks down",
    flags: [{ name: "dry-run", help: "report what would be stopped and removed" }],
  },
  {
    name: "setup",
    usage: "setup <sequence> [args]",
    summary: "Run a named setup sequence; stops at the first step whose end state doesn't appear",
    example: "control-runbooks setup scenario group-exists",
    flags: [],
  },
  {
    name: "snapshot",
    usage: "snapshot [target flags]",
    summary: "The accessibility tree as YAML: roles, names, values, states",
    example: "control-runbooks snapshot --within group",
    flags: TARGET_FLAGS,
  },
  {
    name: "screenshot",
    usage: "screenshot [<label>] [target flags]",
    summary: "Save a screenshot of the window, or of one element, to the evidence folder",
    example: "control-runbooks screenshot code-tab --within group",
    flags: TARGET_FLAGS,
  },
  {
    name: "click",
    usage: "click <role:name> | [target flags]",
    summary: "Click an element",
    example: "control-runbooks click tab:Code --within group",
    flags: [...TARGET_FLAGS, ...ACT_FLAGS],
    targeted: true,
    acts: true,
  },
  {
    name: "fill",
    usage: "fill <value> [target flags]",
    summary: "Replace a field's text, as typing would",
    example: 'control-runbooks fill platform --label "Group email" --within group',
    flags: [...TARGET_FLAGS, ...ACT_FLAGS],
    targeted: true,
    acts: true,
  },
  {
    name: "type",
    usage: "type <text> [target flags]",
    summary: "Type into a field key by key, so suggestions and debounces react",
    example: "control-runbooks type ana --label Owners --within group",
    flags: [...TARGET_FLAGS, ...ACT_FLAGS],
    targeted: true,
    acts: true,
  },
  {
    name: "select",
    usage: "select <option> [target flags]",
    summary: "Pick an option of a <select> by its label or value",
    example: 'control-runbooks select "Group exists already" --label "Simulation scenario"',
    flags: [...TARGET_FLAGS, ...ACT_FLAGS],
    targeted: true,
    acts: true,
  },
  {
    name: "press",
    usage: "press <key> [target flags]",
    summary: "Press a key, in the focused element or the target",
    example: "control-runbooks press Enter",
    flags: [...TARGET_FLAGS, ...ACT_FLAGS],
    acts: true,
  },
  {
    name: "wait",
    usage: "wait <role:name> | [target flags] [--gone] [--timeout ms]",
    summary: "Wait until an element shows (or, with --gone, disappears)",
    example: 'control-runbooks wait --text "Applied." --within group --timeout 20000',
    flags: [
      ...TARGET_FLAGS,
      { name: "gone", help: "wait for it to disappear instead" },
      { name: "timeout", value: "ms", help: "how long to wait (10000)" },
    ],
    targeted: true,
  },
  {
    name: "logs",
    usage: "logs [--source console|main] [--errors] [--tail n]",
    summary: "The renderer console or the main process output since launch",
    example: "control-runbooks logs --errors",
    flags: [
      { name: "source", value: "console|main", help: "which log (console)" },
      { name: "errors", help: "only errors and warnings" },
      { name: "tail", value: "n", help: "only the last n lines (50)" },
    ],
  },
  {
    name: "eval",
    usage: "eval <javascript>",
    summary: "Escape hatch: evaluate an expression in the renderer and print its JSON",
    example: "control-runbooks eval 'document.title'",
    flags: [],
  },
  {
    name: "cdp",
    usage: "cdp <Domain.method> [json-params]",
    summary: "Escape hatch: send a raw Chrome DevTools Protocol command to the window",
    example: "control-runbooks cdp Performance.getMetrics",
    flags: [],
  },
]

export class UsageError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
  }
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

/** The candidates closest to `wanted`: containing it first, then by edit distance. */
export function closest(wanted: string, candidates: readonly string[], limit = 5): string[] {
  const w = wanted.toLowerCase()
  return [...new Set(candidates)]
    .map((c) => {
      const l = c.toLowerCase()
      const score = l.includes(w) || w.includes(l) ? 0 : distance(w, l) / Math.max(w.length, 1)
      return { c, score }
    })
    .filter(({ score }) => score <= 0.75)
    .sort((a, b) => a.score - b.score || a.c.length - b.c.length)
    .slice(0, limit)
    .map(({ c }) => c)
}

export function commandSpec(name: string): CommandSpec {
  const spec = COMMANDS.find((c) => c.name === name)
  if (spec) return spec
  const near = closest(
    name,
    COMMANDS.map((c) => c.name),
  )
  throw new UsageError(
    `Unknown command "${name}".`,
    near.length ? `Did you mean: ${near.join(", ")}?` : "Run control-runbooks --help for the list.",
  )
}

/** A `role:name` shorthand, such as `tab:Code` or `button:Merge Pull Request`. */
function shorthand(arg: string): { role: string; name: string } | undefined {
  const match = /^([a-z]+):(.+)$/.exec(arg)
  return match ? { role: match[1]!, name: match[2]! } : undefined
}

export function parse(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help", positionals: rest, flags: {}, target: undefined }
  }
  const spec = commandSpec(command)
  const known = new Map([...spec.flags, ...COMMON_FLAGS].map((f) => [f.name, f]))
  const flags: Record<string, string | true> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const flag = known.get(rawName)
    if (!flag) {
      const near = closest(rawName, [...known.keys()])
      throw new UsageError(
        `${command} has no --${rawName} flag.`,
        near.length
          ? `Did you mean ${near.map((n) => `--${n}`).join(", ")}?`
          : `Run control-runbooks ${command} --help.`,
      )
    }
    if (!flag.value) {
      flags[rawName] = true
      continue
    }
    const value = inline ?? rest[++i]
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${rawName} needs a value: <${flag.value}>.`, spec.example)
    }
    flags[rawName] = value
  }
  return { command, positionals, flags, target: targetOf(spec, positionals, flags) }
}

function targetOf(
  spec: CommandSpec,
  positionals: string[],
  flags: Record<string, string | true>,
): Target | undefined {
  const str = (name: string) =>
    typeof flags[name] === "string" ? (flags[name] as string) : undefined
  // click and wait take the element as `role:name`; the other commands' positional is a value.
  const short =
    (spec.name === "click" || spec.name === "wait") && positionals[0]
      ? shorthand(positionals[0])
      : undefined
  if ((spec.name === "click" || spec.name === "wait") && positionals[0] && !short) {
    throw new UsageError(
      `"${positionals[0]}" isn't a role:name target.`,
      `Write it as role:name, such as button:Next, or use --role/--name, --label, --text or --testid. ${spec.example}`,
    )
  }
  const nth = str("nth")
  if (nth !== undefined && !/^\d+$/.test(nth)) throw new UsageError("--nth takes a number, from 0.")
  const target: Target = {
    role: short?.role ?? str("role"),
    name: short?.name ?? str("name"),
    label: str("label"),
    text: str("text"),
    testid: str("testid"),
    css: str("css"),
    within: str("within"),
    nth: nth === undefined ? undefined : Number(nth),
    exact: flags.exact === true,
  }
  const kinds = [target.role, target.label, target.text, target.testid, target.css].filter(
    (k) => k !== undefined,
  )
  if (kinds.length > 1) {
    throw new UsageError(
      "Name the element one way: --role (with --name), --label, --text, --testid, or --css.",
    )
  }
  if (target.name !== undefined && target.role === undefined) {
    throw new UsageError("--name goes with --role, such as --role button --name Next.")
  }
  if (kinds.length === 0) {
    if (spec.targeted) {
      throw new UsageError(`${spec.name} needs an element.`, spec.example)
    }
    return target.within === undefined ? undefined : target
  }
  return target
}

/** How a target reads in messages, such as `button "Next" in group`. */
export function describeTarget(t: Target): string {
  const what =
    t.role !== undefined
      ? `${t.role}${t.name !== undefined ? ` "${t.name}"` : ""}`
      : t.label !== undefined
        ? `field labeled "${t.label}"`
        : t.text !== undefined
          ? `text "${t.text}"`
          : t.testid !== undefined
            ? `testid "${t.testid}"`
            : t.css !== undefined
              ? `css ${t.css}`
              : "the window"
  return `${what}${t.nth !== undefined ? ` #${t.nth}` : ""}${t.within ? ` in ${t.within}` : ""}`
}

export function helpText(name?: string): string {
  if (!name) {
    const width = Math.max(...COMMANDS.map((c) => c.name.length))
    return [
      "control-runbooks: drive a running Runbooks app one user action at a time.",
      "Every command prints one JSON object; acting commands save a screenshot as evidence.",
      "",
      "Commands:",
      ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
      "",
      "Run control-runbooks <command> --help for its flags and an example.",
    ].join("\n")
  }
  const spec = commandSpec(name)
  const flags = [...spec.flags, ...COMMON_FLAGS]
  const width = Math.max(...flags.map((f) => f.name.length + (f.value ? f.value.length + 3 : 0)))
  return [
    `control-runbooks ${spec.usage}`,
    "",
    spec.summary,
    "",
    "Flags:",
    ...flags.map(
      (f) => `  --${(f.value ? `${f.name} <${f.value}>` : f.name).padEnd(width)}  ${f.help}`,
    ),
    "",
    `Example: ${spec.example}`,
  ].join("\n")
}
