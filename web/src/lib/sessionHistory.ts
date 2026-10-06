/**
 * What blocks put in the session's history, and how they read it back.
 *
 * The main process stores a payload as JSON without looking inside it
 * (src/domain/session/history.ts). Every payload is parsed here before a block
 * starts from it: a later version of the app may have written another shape,
 * and a block that can't read its payload starts over.
 */
import { z } from "zod"
import type { ExecState, LogEntry } from "@/hooks/useApiExec"
import { decodeOutputs, encodeOutputs } from "@/lib/outputValues"
import { createAppError } from "@/types/error"

// ---------------------------------------------------------------------------
// Forms (`inputs` events)
// ---------------------------------------------------------------------------

const SavedFormSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  /** Whether the user had submitted the form (Inputs) or generated its files (Template) */
  submitted: z.boolean(),
})

export type SavedForm = z.infer<typeof SavedFormSchema>

export function parseSavedForm(payload: unknown): SavedForm | undefined {
  const parsed = SavedFormSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

/** The value the saved form has for a variable, or undefined when it has none. */
export function savedFormValue(saved: SavedForm | undefined, name: string): unknown {
  return saved !== undefined && Object.hasOwn(saved.values, name) ? saved.values[name] : undefined
}

// ---------------------------------------------------------------------------
// Template writes (`render` events)
// ---------------------------------------------------------------------------

const SavedRenderSchema = z.object({
  /** SHA-256 of what the template last wrote: its files and the values it rendered them with */
  writtenHash: z.string(),
})

export type SavedRender = z.infer<typeof SavedRenderSchema>

export function parseSavedRender(payload: unknown): SavedRender | undefined {
  const parsed = SavedRenderSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------------------
// Repositories (`clone` events)
// ---------------------------------------------------------------------------

const SavedCloneSchema = z.discriminatedUnion("status", [
  /** The user started over ("Clone again", "Stop using this repo") */
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("ready"),
    source: z.enum(["clone", "local"]),
    /** The form as the user filled it in for this repository */
    form: z.object({
      gitUrl: z.string(),
      ref: z.string(),
      repoPath: z.string(),
      localPath: z.string(),
      repoDir: z.string(),
    }),
    result: z.object({
      fileCount: z.number(),
      absolutePath: z.string(),
      relativePath: z.string(),
      ref: z.string().optional(),
      hasCommits: z.boolean().optional(),
    }),
    /** What git:local-repo reported for a local checkout */
    localInfo: z
      .object({
        absolutePath: z.string(),
        relativePath: z.string(),
        fileCount: z.number(),
        remoteUrl: z.string().optional(),
        ref: z.string().optional(),
        refType: z.enum(["branch", "tag", "detached"]).optional(),
        commitSha: z.string().optional(),
        hasCommits: z.boolean().optional(),
      })
      .nullable(),
    outputs: z.record(z.string(), z.string()),
  }),
])

export type SavedClone = z.infer<typeof SavedCloneSchema>

export function parseSavedClone(payload: unknown): SavedClone | undefined {
  const parsed = SavedCloneSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------------------
// Pull and merge requests (`pull-request` events)
// ---------------------------------------------------------------------------

const SavedPullRequestSchema = z.discriminatedUnion("status", [
  /** The user set the request aside to open another */
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("created"),
    result: z.object({ prUrl: z.string(), prNumber: z.number(), branchName: z.string() }),
    /** What the main process registered as the block's outputs for it */
    outputs: z.record(z.string(), z.string()),
  }),
])

export type SavedPullRequest = z.infer<typeof SavedPullRequestSchema>

export function parseSavedPullRequest(payload: unknown): SavedPullRequest | undefined {
  const parsed = SavedPullRequestSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------------------
// Sign-ins (`auth` events)
//
// Each auth block keeps its own payload, tagged with the block type: a
// runbook edited between sessions can give another type of block the id.
// ---------------------------------------------------------------------------

const SignedOutSchema = z.object({ status: z.literal("signed-out") })

const SavedAwsAuthSchema = z.discriminatedUnion("status", [
  SignedOutSchema,
  z.object({
    status: z.literal("signed-in"),
    block: z.literal("aws"),
    credentials: z.object({
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      sessionToken: z.string().optional(),
      region: z.string(),
      expiresAt: z.string().optional(),
    }),
    account: z.object({
      accountId: z.string().optional(),
      accountName: z.string().optional(),
      arn: z.string().optional(),
    }),
  }),
])

export type SavedAwsAuth = z.infer<typeof SavedAwsAuthSchema>

export function parseSavedAwsAuth(payload: unknown): SavedAwsAuth | undefined {
  const parsed = SavedAwsAuthSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

const EncodedOutputsSchema = z.record(
  z.string(),
  z.object({ value: z.string(), sensitive: z.boolean() }),
)

const SavedGitAuthSchema = z.discriminatedUnion("status", [
  SignedOutSchema,
  z.object({
    status: z.literal("signed-in"),
    block: z.literal("git"),
    provider: z.enum(["github", "gitlab"]),
    /** The host the credential was validated against */
    host: z.string(),
    /** The GitLab instance URL field, "" when the host came from the picker */
    instanceUrl: z.string(),
    user: z.object({
      login: z.string(),
      name: z.string().optional(),
      avatarUrl: z.string().optional(),
      email: z.string().optional(),
    }),
    source: z.enum(["env", "cli", "block"]).nullable(),
    scopes: z.array(z.string()).nullable(),
    /** When the token expires, as an ISO timestamp */
    expiresAt: z.string().optional(),
    tokenType: z
      .enum(["classic_pat", "fine_grained_pat", "oauth", "github_app", "pat", "unknown"])
      .nullable(),
    meta: z
      .object({
        source: z.enum(["env", "cli", "config"]).optional(),
        envVar: z.string().optional(),
        validatedVia: z.enum(["direct", "cli"]).optional(),
      })
      .nullable(),
    /** The block's outputs. A token the block holds itself (a PAT) is among them, sensitive. */
    outputs: EncodedOutputsSchema,
  }),
])

export type SavedGitAuth = z.infer<typeof SavedGitAuthSchema>

export function parseSavedGitAuth(payload: unknown): SavedGitAuth | undefined {
  const parsed = SavedGitAuthSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

/**
 * How a GoogleAuth block signed in, as far as a resumed session can do it
 * again. The main process deletes the credential files it writes when the app
 * quits, so only a sign-in from a credential that is still on disk, or in
 * another block's outputs, can be redone: `none` covers the rest (a pasted
 * key, Google sign-in).
 */
const GoogleSignInSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("detected"),
    source: z.enum(["env", "adc", "gcloud"]),
    prefix: z.string().optional(),
    configuration: z.string().optional(),
  }),
  z.object({ kind: z.literal("block"), blockId: z.string() }),
  z.object({ kind: z.literal("key-file"), keyPath: z.string() }),
  z.object({ kind: z.literal("gcloud"), configuration: z.string() }),
])

export type GoogleSignIn = z.infer<typeof GoogleSignInSchema>

const SavedGoogleAuthSchema = z.discriminatedUnion("status", [
  SignedOutSchema,
  z.object({
    status: z.literal("signed-in"),
    block: z.literal("google"),
    signIn: GoogleSignInSchema,
    account: z.object({
      principal: z.string().optional(),
      accountType: z.enum(["service_account", "user"]).optional(),
      credentialType: z
        .enum([
          "service_account",
          "authorized_user",
          "external_account",
          "impersonated_service_account",
          "access_token",
          "gce_metadata",
        ])
        .optional(),
      scopes: z.array(z.string()).optional(),
      /** When a bare access token expires, as an ISO timestamp */
      expiresAt: z.string().optional(),
    }),
    projectId: z.string(),
    projectName: z.string().optional(),
    region: z.string(),
    zone: z.string(),
  }),
])

export type SavedGoogleAuth = z.infer<typeof SavedGoogleAuthSchema>

export function parseSavedGoogleAuth(payload: unknown): SavedGoogleAuth | undefined {
  const parsed = SavedGoogleAuthSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

// ---------------------------------------------------------------------------
// Script runs (`run` events)
// ---------------------------------------------------------------------------

// How much of a run's log its event keeps. The history has an event for every
// run, so a log of any length would grow the database without limit.
const MAX_SAVED_LOG_LINES = 500
const MAX_SAVED_LOG_CHARS = 64 * 1024

// The most JSON a run's outputs may be for its event to keep them. The main
// process refuses an event over SESSION_EVENT_PAYLOAD_MAX_LENGTH (1 MiB), and a
// refused run-ended event would leave the run looking as if it never ended.
// This leaves room for the log, whose JSON can be several times its text.
const MAX_SAVED_OUTPUTS_CHARS = 512 * 1024

const SavedRunSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }),
  z.object({
    status: z.enum(["pending", "success", "warn", "fail"]),
    exitCode: z.number().nullable(),
    logs: z.array(z.object({ line: z.string(), timestamp: z.string() })),
    /** How many lines before `logs` were left out */
    omittedLogLines: z.number(),
    /** The run's full log file, in the session's directory */
    logFile: z.string().nullable(),
    outputs: z
      .record(z.string(), z.object({ value: z.string(), sensitive: z.boolean() }))
      .nullable(),
    /** Whether the run had outputs that were too large to keep */
    outputsOmitted: z.boolean(),
    error: z.object({ message: z.string(), details: z.string() }).nullable(),
  }),
])

type SavedRun = z.infer<typeof SavedRunSchema>

/** The event of a run starting. */
export function runStarted(): SavedRun {
  return { status: "running" }
}

/** The event of a run that is over, from the state it left its block in. */
export function runEnded(state: ExecState): SavedRun {
  const logs = logTail(state.logs)
  // The real values of sensitive outputs: the main process encrypts the payload.
  const outputs = state.outputs === null ? null : encodeOutputs(state.outputs)
  const outputsOmitted =
    outputs !== null && JSON.stringify(outputs).length > MAX_SAVED_OUTPUTS_CHARS
  return {
    // A run that is over is never 'running': a stopped one is back to 'pending'.
    status: state.status === "running" ? "pending" : state.status,
    exitCode: state.exitCode,
    logs,
    omittedLogLines: state.logs.length - logs.length,
    logFile: state.logFilePath,
    outputs: outputsOmitted ? null : outputs,
    outputsOmitted,
    error: state.error,
  }
}

/**
 * The state a block starts from, given its latest `run` event. A run that
 * never ended (the app quit, or the runbook was closed or reloaded, while it
 * ran) leaves the block not run, with an error saying so: the script may have
 * done part of its work.
 */
export function restoreRun(payload: unknown): ExecState | undefined {
  const parsed = SavedRunSchema.safeParse(payload)
  if (!parsed.success) return undefined
  const run = parsed.data
  const state: ExecState = {
    logs: [],
    status: "pending",
    exitCode: null,
    error: null,
    outputs: null,
    logFilePath: null,
  }

  if (run.status === "running") {
    return {
      ...state,
      error: createAppError(
        "The last run of this block did not finish",
        "Runbooks quit, or the runbook was closed or reloaded, while the script was running. How far it got is not known.",
      ),
    }
  }

  const firstLine = run.logs[0]
  const omitted: LogEntry[] =
    run.omittedLogLines > 0 && firstLine !== undefined
      ? [
          {
            line:
              run.logFile === null
                ? `[${run.omittedLogLines} earlier ${run.omittedLogLines === 1 ? "line was" : "lines were"} not saved with the session]`
                : `[${run.omittedLogLines} earlier ${run.omittedLogLines === 1 ? "line is" : "lines are"} only in the full log file]`,
            timestamp: firstLine.timestamp,
          },
        ]
      : []
  return {
    ...state,
    status: run.status,
    exitCode: run.exitCode,
    logs: [...omitted, ...run.logs],
    logFilePath: run.logFile,
    outputs: run.outputs === null ? null : decodeOutputs(run.outputs),
    // Blocks that read the outputs wait for them, so say why they are missing.
    error:
      run.error ??
      (run.outputsOmitted
        ? createAppError(
            "The outputs of this run were not saved with the session",
            "They were too large. Run the block again for the blocks that read its outputs.",
          )
        : null),
  }
}

/**
 * The newest lines of a log, within MAX_SAVED_LOG_LINES and
 * MAX_SAVED_LOG_CHARS. A last line longer than that is kept as its end.
 */
function logTail(logs: LogEntry[]): LogEntry[] {
  const last = logs.at(-1)
  if (last === undefined) return []
  if (last.line.length > MAX_SAVED_LOG_CHARS) {
    return [{ ...last, line: last.line.slice(-MAX_SAVED_LOG_CHARS) }]
  }

  let chars = 0
  let start = logs.length
  while (start > 0 && logs.length - start < MAX_SAVED_LOG_LINES) {
    chars += logs[start - 1]!.line.length
    if (chars > MAX_SAVED_LOG_CHARS) break
    start--
  }
  return logs.slice(start)
}
