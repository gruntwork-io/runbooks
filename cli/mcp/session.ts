/**
 * A runbook opened over MCP: the test runner's engine (TestExecutor), run one
 * block at a time on the caller's say-so, with each block's latest result
 * kept so the caller can read it back.
 *
 * Nothing runs when a session opens. Every block runs only from runBlock or
 * runAll, with the runner's semantics and limits (see LIMITATIONS).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { TestExecutor } from "../test/executor.ts"
import type { StepResult } from "../test/config.ts"
import { AUTH_BLOCK_TYPES, PR_BLOCK_TYPES } from "../test/blockTypes.ts"
import { findComponents, type ParsedComponent } from "../../src/domain/registry/executable.ts"
import { parseMdx, stringProp } from "../../src/mdx.ts"

const PR_BLOCKS = new Set<string>(PR_BLOCK_TYPES)
const AUTH_BLOCKS = new Set<string>(AUTH_BLOCK_TYPES)
/** Statuses of a block that has run and is done with. */
const DONE = new Set<BlockStatus>(["success", "warn", "valid"])

/**
 * Why skip_block refuses a block of this type, if it does. An auth block
 * provides the credentials the blocks after it run with: skipped, they would
 * stay blocked or, for blocks that don't name it, run without them. A form
 * holds values other blocks read: review it with set_inputs or
 * confirm_inputs instead.
 */
function unskippableReason(type: string): string | undefined {
  if (AUTH_BLOCKS.has(type)) {
    return "Auth blocks can't be skipped: the blocks that use them would stay blocked, or run without the credentials they expect. Sign in so the block finds credentials, then run it."
  }
  if (type === "Inputs") {
    return "Inputs blocks can't be skipped: other blocks read their values. Review them with set_inputs or confirm_inputs."
  }
  return undefined
}

/** Per-script time limit when the caller doesn't set one. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** How the runner differs from the app, for every session. */
export const LIMITATIONS = [
  "Blocks run headless with the Runbooks test runner's engine, not the desktop app. Scripts are real: they run on this machine with your environment and credentials and can change real cloud resources.",
  "A block runs to completion before the tool returns; logs arrive all at once at the end, and a running script can't be cancelled except by its timeout.",
  "Templates use the runner's simplified renderer: {{ .inputs.X }}, {{ .outputs.block.name }}, a non-nested {{ if .x }}...{{ else }}...{{ end }} and {{ fromJson ... }}. Pipes, eq and other functions, range, with and {{- -}} are left in the script as written (see each block's template_warnings).",
  "Auth blocks never sign in or contact the cloud: they pick up credentials from environment variables or an existing CLI sign-in (az, gcloud ADC, AWS profile) and pass them to later blocks. They don't check that the credential works or has the roles a block needs.",
  "Pull request blocks (GitPullRequest, GitHubPullRequest, GitLabMergeRequest) can't run headless; they can only be skipped.",
  "Every Inputs and Template form must be reviewed before a block that reads it runs: set its values with set_inputs, or accept them with confirm_inputs. A default counts as unreviewed.",
  "skip_block refuses auth blocks, Inputs blocks and blocks that already completed.",
  "DirPicker blocks can't run headless; a block that reads their output stays blocked.",
  "Iframe blocks can't show their page; pass the outputs the page would set with set_outputs.",
  "Prerequisites blocks check tools on the PATH the server started with; they don't reread your login shell's PATH.",
  "A block's timeoutMs prop is ignored; every script gets the session's timeout.",
]

/** What each block type does when run headless, where it differs from running it in the app. */
const BLOCK_TYPE_NOTES: Record<string, string> = {
  AwsAuth:
    "Reads AWS credentials from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or AWS_ROLE_ARN with AWS_WEB_IDENTITY_TOKEN_FILE. Never contacts AWS. Skips when none is set.",
  AzureAuth:
    "Reads a service principal from ARM_*/AZURE_* variables, else uses the Azure CLI sign-in in AZURE_CONFIG_DIR or ~/.azure. Never runs az login or contacts Azure, and doesn't check requiredRoles. Skips when neither is found.",
  GoogleAuth:
    "Reads Google credentials from GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CREDENTIALS, an access token variable, or gcloud's ADC file. Never contacts Google.",
  GitHubAuth:
    "Reads a token from RUNBOOKS_GITHUB_TOKEN, GITHUB_TOKEN or GH_TOKEN. Never validates it.",
  GitLabAuth:
    "Reads a token from GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN. Never validates it.",
  GitAuth: "Reads a GitHub or GitLab token from the environment, by its provider prop.",
  GitClone:
    "Clones prefilledUrl (or uses prefilledRepoDir) into the working directory. Skips without one. Doesn't set repo_owner, repo_name, org_id or repo_id outputs.",
  GitPullRequest: "Can't run headless: it would push a branch and open a pull request. Skip it.",
  GitHubPullRequest: "Can't run headless: it would push a branch and open a pull request. Skip it.",
  GitLabMergeRequest:
    "Can't run headless: it would push a branch and open a merge request. Skip it.",
  Iframe: "The page can't be shown; pass set_outputs with the values it would set.",
  Template:
    "Renders with the runner's renderer. File and directory names aren't rendered, dotfiles aren't written, and boilerplate.yml settings other than variables are ignored.",
  TemplateInline:
    "Renders with the runner's renderer. Without outputPath it is a configuration error.",
  Inputs: "Holds values only; set them with set_inputs. Running it validates them.",
  Command:
    "Runs its script. Exit 0 is success, 2 is warn (blocks that depend on it may run, unlike in the app), anything else is fail.",
}

/** The status of a block in a session. */
export type BlockStatus =
  | "not_run"
  | "success"
  | "warn"
  | "fail"
  | "timeout"
  | "skipped"
  | "blocked"
  | "error"
  | "config_error"
  | "valid"
  | "unsupported"
  | "needs_review"

interface BlockRecord {
  status: BlockStatus
  runs: number
  exitCode?: number | undefined
  error?: string | undefined
  logs?: string | undefined
  durationMs?: number | undefined
}

export interface OpenOptions {
  /** Where scripts start and files are generated. Default: a new temporary directory, kept after close. */
  workingDir?: string
  /** Per-script time limit. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Environment variables for every block, on top of the server's. */
  env?: Record<string, string>
  /** Initial input values, `inputsID.varName` keys. */
  inputs?: Record<string, unknown>
}

export interface RunOptions {
  /** For an auth block: the prefix of the environment variables to read credentials from. */
  envPrefix?: string
  /** For an Iframe block: the outputs its page would set. */
  setOutputs?: Record<string, string>
  /** Characters of log to return, from the end. */
  logChars?: number
}

const DEFAULT_LOG_CHARS = 8000

/** Resolve a runbook path given as a directory or a runbook file. */
export function resolveRunbookPath(input: string): string {
  const abs = path.resolve(input)
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    throw new Error(`Path not found: ${abs}`)
  }
  const file = stat.isDirectory() ? path.join(abs, "runbook.mdx") : abs
  if (!fs.existsSync(file)) throw new Error(`No runbook.mdx in ${abs}`)
  return file
}

/**
 * The template actions in `text` the runner's renderer leaves as written:
 * anything other than a reference, a non-nested if/else/end, or fromJson.
 */
export function unsupportedTemplateActions(text: string): string[] {
  const supported = [
    /^\.[a-zA-Z0-9_.]+$/,
    /^if\s+\.[a-zA-Z0-9_.]+$/,
    /^else$/,
    /^end$/,
    /^fromJson\s+\.[a-zA-Z0-9_.]+$/,
  ]
  const found = new Set<string>()
  for (const match of text.matchAll(/\{\{(-?)([\s\S]*?)(-?)\}\}/g)) {
    const action = match[2]!.trim()
    if (match[1] || match[3] || !supported.some((re) => re.test(action))) {
      found.add(match[0].length > 80 ? match[0].slice(0, 77) + "..." : match[0])
    }
  }
  return [...found]
}

function tail(text: string | undefined, chars: number): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false }
  // slice(-0) is the whole string
  if (chars <= 0) return { text: "", truncated: true }
  if (text.length <= chars) return { text, truncated: false }
  return { text: text.slice(-chars), truncated: true }
}

export class RunbookSession {
  private records = new Map<string, BlockRecord>()
  private userInputs: Record<string, unknown> = {}
  private inputErrors: string[] = []
  private dirPickers: string[] = []
  /** The input keys (`form.Var`) the caller set or confirmed. Any other value, a default included, is unreviewed. */
  private reviewed = new Set<string>()

  private constructor(
    readonly id: string,
    readonly runbookPath: string,
    readonly workingDir: string,
    readonly timeoutMs: number,
    private executor: TestExecutor,
  ) {}

  /** Open a runbook. Parses it and checks its configuration; runs nothing. */
  static async open(id: string, input: string, opts: OpenOptions = {}): Promise<RunbookSession> {
    const runbookPath = resolveRunbookPath(input)
    const workingDir = opts.workingDir
      ? path.resolve(opts.workingDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-mcp-"))
    fs.mkdirSync(workingDir, { recursive: true })
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const executor = new TestExecutor(runbookPath, workingDir, "generated", {
      timeout: timeoutMs,
      verbose: false,
    })
    await executor.init()
    const session = new RunbookSession(id, runbookPath, workingDir, timeoutMs, executor)
    const parsed = parseMdx(fs.readFileSync(runbookPath, "utf-8"))
    if (parsed.ok) {
      session.dirPickers = findComponents(parsed.elements, "DirPicker").map((c) => c.id)
    }
    session.userInputs = { ...opts.inputs }
    for (const key of Object.keys(session.userInputs)) session.reviewed.add(key)
    session.inputErrors = executor
      .beginSession(session.userInputs, opts.env ?? {}, workingDir)
      .map((e) => `${e.inputKey}: ${e.message}`)
    return session
  }

  private block(id: string): ParsedComponent {
    const block = this.executor.getBlocks().find((b) => b.id === id)
    if (!block) {
      const ids = this.executor.getBlocks().map((b) => b.id)
      throw new Error(`The runbook has no block "${id}". Its blocks: ${ids.join(", ")}`)
    }
    return block
  }

  private record(id: string): BlockRecord {
    return this.records.get(id) ?? { status: "not_run", runs: 0 }
  }

  /** The runbook's blocks, their dependencies and statuses, its inputs and its limitations. */
  describe() {
    const unknown = this.executor.getUnknownBlockTypes()
    const warnings = [
      ...unknown.map((t) => `Block type ${t} is unknown to this version of Runbooks.`),
      ...this.dirPickers.map(
        (id) =>
          `DirPicker "${id}" can't run headless; blocks that read its PATH output stay blocked.`,
      ),
    ]
    return {
      session_id: this.id,
      runbook: this.runbookPath,
      working_dir: this.workingDir,
      generated_files_dir: this.executor.getOutputDir(),
      script_timeout_seconds: Math.round(this.timeoutMs / 1000),
      blocks: this.executor.getBlocks().map((b) => this.summary(b)),
      inputs: this.inputsView(),
      input_errors: this.inputErrors,
      warnings,
      limitations: LIMITATIONS,
    }
  }

  private summary(block: ParsedComponent) {
    const rec = this.record(block.id)
    const blockedBy = rec.status === "success" ? [] : this.executor.blockedReasons(block.id)
    return {
      id: block.id,
      type: block.type,
      title: stringProp(block.props, "title") || undefined,
      status: rec.status,
      ...(blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      ...(PR_BLOCKS.has(block.type) ? { runnable: false } : {}),
    }
  }

  /** The variables of every Inputs and Template block, with their current values. */
  inputsView() {
    const values = this.executor.getSessionInputs()
    const blocks: Record<string, unknown>[] = []
    for (const [blockId, schema] of this.executor.getInputSchemas()) {
      blocks.push({
        block: blockId,
        variables: [...schema.variables.values()].map((v) => {
          const key = `${blockId}.${v.name}`
          const value = values[key]
          return {
            key,
            type: v.type,
            description: v.description || undefined,
            required: v.required || undefined,
            sensitive: v.sensitive || undefined,
            options: v.options,
            options_from: v.optionsFrom
              ? `outputs.${v.optionsFrom.blockId}.${v.optionsFrom.outputName}`
              : undefined,
            default: v.sensitive ? undefined : v.default,
            value: v.sensitive && value !== undefined ? "<redacted>" : value,
            set_by_caller: key in this.userInputs || undefined,
            reviewed: this.reviewed.has(key),
          }
        }),
      })
    }
    return blocks
  }

  /**
   * Merge (or with replace, replace) the caller's input values, then validate
   * them all. Each value set counts as reviewed.
   */
  setInputs(values: Record<string, unknown>, replace = false) {
    this.userInputs = replace ? { ...values } : { ...this.userInputs, ...values }
    if (replace) this.reviewed.clear()
    for (const key of Object.keys(values)) this.reviewed.add(key)
    const known = new Set<string>()
    for (const [blockId, schema] of this.executor.getInputSchemas()) {
      for (const name of schema.variables.keys()) known.add(`${blockId}.${name}`)
    }
    const unknownKeys = Object.keys(values).filter((k) => !known.has(k))
    this.inputErrors = [
      ...unknownKeys.map((k) => `${k}: no Inputs or Template block declares this variable`),
      ...this.executor.setSessionInputs(this.userInputs).map((e) => `${e.inputKey}: ${e.message}`),
    ]
    return { input_errors: this.inputErrors, inputs: this.inputsView() }
  }

  /**
   * Accept form `formId`'s values as they stand, defaults included, as a
   * person does by reading the form and moving on. Returns the form.
   */
  confirmInputs(formId: string) {
    this.block(formId)
    if (!this.executor.getInputSchemas().has(formId)) {
      throw new Error(
        `Block "${formId}" is not an Inputs or Template block, so it has no form to confirm.`,
      )
    }
    for (const name of this.executor.formOwnVariables(formId))
      this.reviewed.add(`${formId}.${name}`)
    return { confirmed: formId, form: this.formView(formId) }
  }

  /** The variables of form `formId` the caller hasn't set or confirmed. */
  private unreviewed(formId: string): string[] {
    return this.executor
      .formOwnVariables(formId)
      .map((name) => `${formId}.${name}`)
      .filter((key) => !this.reviewed.has(key))
  }

  /** Form `formId`'s fields as a person sees them: description, default, validation, value. */
  private formView(formId: string) {
    const schema = this.executor.getInputSchemas().get(formId)
    const values = this.executor.getSessionInputs()
    const own = new Set(this.executor.formOwnVariables(formId))
    return {
      form: formId,
      type: this.block(formId).type,
      fields: [...(schema?.variables.values() ?? [])]
        .filter((v) => own.has(v.name))
        .map((v) => {
          const key = `${formId}.${v.name}`
          const value = values[key]
          return {
            key,
            type: v.type,
            description: v.description || undefined,
            default: v.sensitive ? undefined : v.default,
            value: v.sensitive && value !== undefined ? "<redacted>" : value,
            required: v.required || undefined,
            validations:
              v.validations.length > 0
                ? v.validations.map((rule) => ({ type: rule.type, args: rule.args }))
                : undefined,
            options: v.options,
            sensitive: v.sensitive || undefined,
            reviewed: this.reviewed.has(key),
          }
        }),
    }
  }

  /**
   * The first form block `id` reads (itself, for a form) with values the
   * caller hasn't set or confirmed, as the review it needs before it runs.
   */
  private reviewNeeded(id: string) {
    for (const formId of this.executor.formsReadBy(id)) {
      const pending = this.unreviewed(formId)
      if (pending.length === 0) continue
      return {
        ...this.formView(formId),
        unreviewed: pending,
        message:
          `Review form "${formId}" before ${formId === id ? "it is used" : `"${id}" runs`}: ` +
          "its values, defaults included, haven't been set or confirmed. Defaults count as unreviewed. " +
          "Read each field's description, then call set_inputs with the values to use, or confirm_inputs to accept them as shown.",
      }
    }
    return undefined
  }

  /** Block `id` in full: status, dependencies, why it's blocked, its last run's logs and outputs. */
  getBlock(id: string, logChars = DEFAULT_LOG_CHARS) {
    const block = this.block(id)
    const rec = this.record(id)
    const auth = this.executor.getAuthDependencies(id).map((dep) => dep.authBlockId)
    const logs = tail(rec.logs, logChars)
    const configError = this.executor.getBlockConfigError(block)
    const templateWarnings = unsupportedTemplateActions(
      this.executor.blockSources(block).join("\n"),
    )
    return {
      id,
      type: block.type,
      title: stringProp(block.props, "title") || undefined,
      description: stringProp(block.props, "description") || undefined,
      status: rec.status,
      runs: rec.runs,
      depends_on: {
        inputs_from: this.executor.getInputsIds(id),
        auth_block: auth[0],
        auth_blocks: auth,
        depends_on: this.executor.getRunDependencies(id),
      },
      blocked_by: this.executor.blockedReasons(id),
      ...(configError ? { config_error: configError } : {}),
      last_run:
        rec.runs > 0
          ? {
              status: rec.status,
              exit_code: rec.exitCode,
              error: rec.error,
              duration_ms: rec.durationMs,
              logs: logs.text,
              logs_truncated: logs.truncated || undefined,
            }
          : undefined,
      outputs: this.executor.getSessionOutputs()[id] ?? {},
      ...(BLOCK_TYPE_NOTES[block.type] ? { headless_behavior: BLOCK_TYPE_NOTES[block.type] } : {}),
      ...(templateWarnings.length > 0
        ? {
            template_warnings: templateWarnings.map(
              (t) =>
                `${t} is not supported by the headless renderer and is passed through as written`,
            ),
          }
        : {}),
    }
  }

  /** Every block's outputs so far, sensitive ones redacted. */
  getOutputs() {
    return this.executor.getSessionOutputs()
  }

  /**
   * Run block `id` once. Refuses, with the reasons, when the block is blocked
   * or can't run headless; never runs a block another way than the app would.
   */
  runBlock(id: string, opts: RunOptions = {}) {
    const block = this.block(id)
    if (PR_BLOCKS.has(block.type)) {
      this.store(id, { status: "unsupported", error: BLOCK_TYPE_NOTES[block.type] })
      return this.getBlock(id, opts.logChars)
    }
    const review = this.reviewNeeded(id)
    if (review) {
      return {
        ...this.getBlock(id, opts.logChars),
        status: "needs_review" as const,
        needs_review: review,
      }
    }
    const configError = this.executor.getBlockConfigError(block)
    const blocked = configError ? [] : this.executor.blockedReasons(id)
    if (blocked.length > 0) {
      this.store(id, { status: "blocked", error: blocked.join("\n") })
      return this.getBlock(id, opts.logChars)
    }
    const result = this.executor.runSessionStep({
      block: id,
      expect: "success",
      ...(opts.envPrefix ? { env_prefix: opts.envPrefix } : {}),
      ...(opts.setOutputs ? { set_outputs: opts.setOutputs } : {}),
    })
    this.storeResult(id, result)
    return this.getBlock(id, opts.logChars)
  }

  /**
   * Mark block `id` as skipped without running it or checking its
   * configuration. Refuses auth blocks and Inputs blocks (unskippableReason)
   * and a block that already ran to completion, whose outputs other blocks may
   * already use: skipping it would leave them in place under a skipped block.
   * The result lists the blocks that wait on this one, and what they read from
   * it, since they stay blocked until those outputs exist.
   */
  skipBlock(id: string) {
    const block = this.block(id)
    const refused = unskippableReason(block.type)
    if (refused) throw new Error(refused)
    const status = this.record(id).status
    if (DONE.has(status)) {
      throw new Error(
        `Block "${id}" already ran (${status}), and blocks after it may use its outputs, so it can't be skipped now.`,
      )
    }
    this.store(id, { status: "skipped" })
    const dependents = this.executor.dependentsOf(id)
    return {
      ...this.getBlock(id),
      dependents,
      ...(dependents.length > 0
        ? {
            note: "These blocks wait on the skipped block and stay blocked until what they read from it exists. A person may provide it another way (for example an environment variable a script reads), but the runner can't fill in a skipped block's outputs.",
          }
        : {}),
    }
  }

  /**
   * Run blocks in document order, from `fromId` (default the first), skipping
   * those that already succeeded unless `rerun`. Stops at the first block
   * that doesn't end in success, warn or valid. Pull request blocks are left
   * unrun and reported, and the run carries on past them.
   */
  runAll(opts: { fromId?: string; rerun?: boolean } = {}) {
    const blocks = this.executor.getBlocks()
    let start = 0
    if (opts.fromId) {
      this.block(opts.fromId)
      start = blocks.findIndex((b) => b.id === opts.fromId)
    }
    const ran: Array<{ id: string; type: string; status: BlockStatus; error?: string }> = []
    let stoppedAt: string | undefined
    let review: ReturnType<RunbookSession["reviewNeeded"]>
    for (const block of blocks.slice(start)) {
      const rec = this.record(block.id)
      if (!opts.rerun && ["success", "warn", "valid", "skipped"].includes(rec.status)) continue
      if (PR_BLOCKS.has(block.type)) {
        this.store(block.id, { status: "unsupported", error: BLOCK_TYPE_NOTES[block.type] })
        ran.push({ id: block.id, type: block.type, status: "unsupported" })
        continue
      }
      const view = this.runBlock(block.id)
      const err = view.last_run?.error
      ran.push({
        id: block.id,
        type: block.type,
        status: view.status,
        ...(err && view.status !== "needs_review" ? { error: err } : {}),
      })
      if ("needs_review" in view) {
        stoppedAt = block.id
        review = view.needs_review
        break
      }
      if (!DONE.has(view.status)) {
        stoppedAt = block.id
        break
      }
    }
    return {
      ran,
      stopped_at: stoppedAt,
      ...(review ? { needs_review: review } : {}),
      next_step: review
        ? `Stopped before form "${review.form}": ${review.message}`
        : stoppedAt
          ? `Stopped at "${stoppedAt}". Call get_block for its logs and blocked_by, fix the cause (set_inputs, or skip_block), then run_block or run_all again.`
          : "Every block has run or was already done.",
      outputs: this.getOutputs(),
    }
  }

  private storeResult(id: string, result: StepResult) {
    let status: BlockStatus
    switch (result.actualStatus) {
      case "success":
      case "warn":
      case "fail":
      case "timeout":
      case "blocked":
      case "config_error":
      case "valid":
        status = result.actualStatus
        break
      case "skipped":
        status = "skipped"
        break
      default:
        status = "error"
    }
    this.store(id, {
      status,
      exitCode: result.exitCode,
      error: result.error && this.executor.redactSensitiveInputs(result.error),
      logs: result.logs && this.executor.redactSensitiveInputs(result.logs),
      durationMs: result.duration,
    })
  }

  private store(id: string, update: Omit<BlockRecord, "runs">) {
    const prev = this.record(id)
    this.records.set(id, { ...update, runs: prev.runs + 1 })
  }
}
