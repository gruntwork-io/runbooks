/**
 * `lookups record`: runs each lookup and check a module uses once against the
 * real APIs and records samples of their answers in its simulation.yml, so a
 * simulation replays the API's real shape rather than the author's reading of
 * it. Requests go through the same rules the auth blocks apply, with
 * credentials from the environment: AWS keys or AWS_PROFILE, and Google's
 * application default credentials.
 */
import * as path from "node:path"
import { createInterface } from "node:readline/promises"
import type { Command } from "commander"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import { ProcessEnvironmentLive } from "../../src/layers/ProcessEnvironment.ts"
import { AwsSdkClientLive } from "../../src/layers/AwsSdkClient.ts"
import { GoogleSdkClientLive } from "../../src/layers/GoogleSdkClient.ts"
import { FileSystem } from "../../src/services/FileSystem.ts"
import { Environment } from "../../src/services/Environment.ts"
import { GoogleClient, type GoogleCredentialRef } from "../../src/services/GoogleClient.ts"
import type { AwsClient, AwsCredentials } from "../../src/services/AwsClient.ts"
import type { HttpReply, HttpRequest } from "../../src/services/HttpRequest.ts"
import type {
  AwsAuthError,
  GoogleAuthError,
  GoogleConfigError,
  RequestRefusedError,
} from "../../src/errors/index.ts"
import {
  authenticateProfile,
  detectEnvCredentials,
  validateCredentials,
} from "../../src/domain/aws/auth.ts"
import { sendAsAws, sendAsGoogle } from "../../src/domain/send-as-me/send.ts"
import { readModuleDeclarations, recordModule } from "../../src/domain/lookups/module.ts"
import type { RunContext } from "../../src/domain/lookups/run.ts"
import type { AuthKind } from "../../src/domain/lookups/types.ts"
import { formatProblem } from "./validate.ts"
import { errorMessage } from "../../src/errors/message.ts"

interface RecordOptions {
  input: string[]
  auth: string[]
  keepValues: boolean
  yes: boolean
}

const collect = (value: string, previous: string[]) => [...previous, value]

export function registerLookupsCommand(program: Command): void {
  const lookups = program.command("lookups").description("Work with a module's lookups and checks")
  lookups
    .command("record")
    .description("Record samples of real API answers in a module's simulation.yml")
    .argument("<module-dir>", "OpenTofu module folder")
    .option("--input <name=value>", "A form value the requests read, repeatable", collect, [])
    .option(
      "--auth <group.fact=value>",
      "Set what a group's auth block knows, such as aws.ssoRegion=us-east-2",
      collect,
      [],
    )
    .option("--keep-values", "Keep real values instead of placeholders", false)
    .option("-y, --yes", "Write the file without asking", false)
    .action(async (dir: string, opts: RecordOptions) => {
      try {
        await record(path.resolve(dir), opts)
      } catch (err) {
        console.error(errorMessage(err))
        process.exitCode = 1
      }
    })
}

const AppLive = Layer.mergeAll(
  NodeFileSystemLive,
  ProcessEnvironmentLive,
  AwsSdkClientLive,
  GoogleSdkClientLive,
)

function pairs(values: readonly string[], what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const value of values) {
    const at = value.indexOf("=")
    if (at < 1) throw new Error(`${what} ${value} must be name=value.`)
    out[value.slice(0, at)] = value.slice(at + 1)
  }
  return out
}

async function record(moduleDir: string, opts: RecordOptions): Promise<void> {
  const runtime = ManagedRuntime.make(AppLive)
  try {
    const declarations = await runtime.runPromise(readModuleDeclarations(moduleDir))
    if (declarations.problems.length > 0) {
      for (const problem of declarations.problems) console.error(formatProblem(problem))
      throw new Error("Fix these problems first: runbooks-cli validate shows them too.")
    }
    const inputs = pairs(opts.input, "--input")
    const overrides = pairs(opts.auth, "--auth")
    const signIns = new Map<AuthKind, Promise<SignIn>>()
    const signIn = (kind: AuthKind) => {
      let pending = signIns.get(kind)
      if (!pending) {
        pending = runtime.runPromise<
          SignIn,
          Error | AwsAuthError | GoogleAuthError | GoogleConfigError
        >(kind === "AwsAuth" ? awsSignIn : googleSignIn)
        signIns.set(kind, pending)
      }
      return pending
    }
    const facts = new Map<string, Record<string, string>>()
    for (const group of Object.values(declarations.definitions.groups)) {
      const own: Record<string, string> = {}
      for (const [name, value] of Object.entries(overrides)) {
        if (name.startsWith(`${group.name}.`)) own[name.slice(group.name.length + 1)] = value
      }
      facts.set(group.name, { ...(await signIn(group.auth)).facts, ...own })
    }
    const context: RunContext = {
      definitions: declarations.definitions,
      inputs,
      auth: (group) => facts.get(group) ?? {},
      send: async (request, _group, kind) => {
        const session = await signIn(kind)
        return runtime.runPromise(session.send(request))
      },
    }
    const result = await runtime.runPromise(
      recordModule(moduleDir, declarations, context, { keepValues: opts.keepValues }),
    )
    for (const failure of result.failures) console.error(`Couldn't record ${failure}`)
    console.log(result.text)
    if (!opts.yes && !(await confirm(`Write ${path.relative(process.cwd(), result.file)}?`))) return
    await runtime.runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.writeFile(result.file, result.text)),
    )
    console.log(`Wrote ${result.file}`)
    if (result.failures.length > 0) process.exitCode = 1
  } finally {
    await runtime.dispose()
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

interface SignIn {
  readonly facts: Record<string, string>
  readonly send: (
    request: HttpRequest,
  ) => Effect.Effect<
    HttpReply,
    RequestRefusedError | AwsAuthError | GoogleAuthError,
    AwsClient | GoogleClient
  >
}

/** AWS credentials from AWS_ACCESS_KEY_ID and friends, or else AWS_PROFILE. */
const awsSignIn = Effect.gen(function* () {
  const env = yield* Environment
  const detected = yield* detectEnvCredentials()
  const profile = yield* env.get("AWS_PROFILE")
  let creds: AwsCredentials
  if (detected?.region) {
    creds = { ...detected, region: detected.region }
  } else if (detected) {
    return yield* Effect.fail(
      new Error("Set AWS_REGION for the AWS credentials in the environment."),
    )
  } else if (profile) {
    creds = yield* authenticateProfile(profile)
  } else {
    return yield* Effect.fail(
      new Error(
        "The module's lookups need AWS: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_PROFILE.",
      ),
    )
  }
  const identity = yield* validateCredentials(creds, creds.region)
  return {
    facts: { region: creds.region, ssoRegion: creds.region, accountId: identity.accountId },
    send: (request) => sendAsAws(creds, request),
  } satisfies SignIn
})

/** Google's application default credentials: GOOGLE_APPLICATION_CREDENTIALS, or gcloud's file. */
const googleSignIn = Effect.gen(function* () {
  const env = yield* Environment
  const google = yield* GoogleClient
  const file =
    (yield* env.get("GOOGLE_APPLICATION_CREDENTIALS")) ||
    (yield* google.readApplicationDefaultCredentials())?.path
  if (!file) {
    return yield* Effect.fail(
      new Error(
        "The module's lookups need Google: run gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS.",
      ),
    )
  }
  const info = yield* google.readCredentialFile(file)
  const project = (yield* env.get("GOOGLE_CLOUD_PROJECT")) || info.quotaProjectId || ""
  const ref: GoogleCredentialRef = { kind: "file", path: file }
  return {
    facts: { email: info.clientEmail ?? "", project },
    send: (request) => sendAsGoogle(ref, request, project || undefined),
  } satisfies SignIn
})
