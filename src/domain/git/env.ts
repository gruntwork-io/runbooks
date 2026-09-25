import { Chunk, Effect, Stream } from "effect"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"

/** ssh options that make it fail instead of prompting (see gitSpawnEnv). */
const SSH_BATCH_OPTIONS = "-o BatchMode=yes -o StrictHostKeyChecking=yes"

/**
 * Lower-cased basename of a program path, without `.exe` — the name git
 * itself matches to tell OpenSSH from plink (its "ssh variant").
 */
const programName = (program: string) =>
  (program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "")

/** The program (first word) of a shell command line, without its quotes. */
const commandProgram = (commandLine: string) => {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(commandLine)
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? ""
}

/** Quote a path for the shell git runs GIT_SSH_COMMAND through. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * GIT_SSH as a command line. It names a bare program that git runs without a
 * shell, hence the quoting. Only ssh and plink are taken over; undefined leaves
 * any other program (TortoisePlink, a wrapper script) for git to run as-is.
 */
const gitSshCommand = (program: string) =>
  ["ssh", "plink"].includes(programName(program)) ? shellQuote(program) : undefined

/**
 * `command` with the no-prompt flags its ssh client understands appended.
 * TortoisePlink gets nothing: git already passes it `-batch` on its own.
 */
const withBatchMode = (command: string) => {
  switch (programName(commandProgram(command))) {
    case "plink":
      return `${command} -batch`
    case "tortoiseplink":
      return command
    default:
      return `${command} ${SSH_BATCH_OPTIONS}`
  }
}

/**
 * Environment for spawning `git` so it can never block on an interactive
 * prompt. Shared by the GitClient layer, the Electron IPC clone handler, and
 * the remote-source resolver — every place that shells out to git.
 *
 * Without these, a clone/push/ls-remote can hang forever:
 *
 *  - SSH host-key verification. The first time we connect to a host that isn't
 *    in known_hosts, ssh asks "Are you sure you want to continue connecting?"
 *    and reads the answer from the controlling terminal — which a spawned git
 *    process has no way to answer, so it blocks indefinitely.
 *  - SSH passphrase / password prompts.
 *  - git's own HTTPS credential prompt.
 *
 * GIT_SSH_COMMAND forces ssh into batch mode (BatchMode=yes → never prompt;
 * fail instead) and keeps strict host-key checking on: an unknown host fails
 * fast with "Host key verification failed" rather than hanging or silently
 * trusting it. To clone such a host, add its key to known_hosts first
 * (e.g. `ssh-keyscan <host> >> ~/.ssh/known_hosts`). ssh still reads
 * ~/.ssh/config, so per-host IdentityFile settings are honored.
 *
 * GIT_SSH_COMMAND outranks every other way of choosing the ssh client, so it
 * wraps the one the user's own git would run rather than replacing it. In
 * git's order of precedence:
 *
 *  1. an inherited GIT_SSH_COMMAND;
 *  2. `sshCommand`, the core.sshCommand that resolveSshCommand looked up for
 *     the repo (multi-account `ssh -i ~/.ssh/id_work`, Windows OpenSSH);
 *  3. GIT_SSH, a bare program path. An ssh or plink one is quoted into the
 *     command; any other (e.g. TortoisePlink, which git runs with `-batch`
 *     itself, or a wrapper script) is left for git to run as-is;
 *  4. plain `ssh`.
 *
 * The flags are appended in the chosen client's own syntax: `-batch` for
 * plink, the `-o` options above for everything else. ssh keeps the first value
 * it sees for an option, so any the user's command sets explicitly still win.
 * A wrapper script that rejects ssh options belongs in GIT_SSH, which is left
 * alone.
 *
 * GIT_TERMINAL_PROMPT=0 makes git itself fail instead of prompting for
 * credentials on the terminal (the HTTPS equivalent of the SSH hang).
 *
 * process.env is spread first so PATH, HOME, and SSH_AUTH_SOCK (the ssh-agent
 * socket) are preserved — passing an explicit env to spawn() replaces the
 * inherited one wholesale, so omitting these would break git and ssh entirely.
 */
export const gitSpawnEnv = (sshCommand?: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  const { GIT_SSH_COMMAND, GIT_SSH } = env
  const command = GIT_SSH_COMMAND || sshCommand || (GIT_SSH ? gitSshCommand(GIT_SSH) : "ssh")
  if (command) env.GIT_SSH_COMMAND = withBatchMode(command)
  else delete env.GIT_SSH_COMMAND
  return env
}

/**
 * The user's core.sshCommand as git resolves it in `cwd` (repo-local,
 * includeIf, global and system config), or undefined when it is unset or
 * cannot be read. Without `cwd` the lookup runs in the process's own cwd,
 * like a git spawned without one.
 *
 * Only commands that reach a remote (clone, push, ls-remote) start ssh, so
 * only those look this up and pass it to gitSpawnEnv; local commands use
 * gitSpawnEnv() as-is. A clone has no repo yet, so its callers look up from
 * an existing directory the clone lands under. There git reads the same global
 * and system config as the clone; inside another checkout it also reads that
 * checkout's config and matches `includeIf "gitdir:..."` rules against it, a
 * close stand-in for the new repo's own.
 */
export const resolveSshCommand = (cwd?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const args = ["config", "--get", "core.sshCommand"]
    const proc = yield* spawner.spawn("git", cwd ? ["-C", cwd, ...args] : args, {
      env: gitSpawnEnv(),
    })

    return yield* Effect.gen(function* () {
      const value = Chunk.toArray(yield* Stream.runCollect(proc.output))
        .filter((l) => l.source === "stdout")
        .map((l) => l.line)
        .join("\n")
        .trim()
      return (yield* proc.exitCode) === 0 && value ? value : undefined
    }).pipe(Effect.ensuring(proc.kill.pipe(Effect.ignore)))
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
