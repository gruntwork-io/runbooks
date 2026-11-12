/**
 * The app instance control-runbooks drives: launching it so later commands,
 * each its own process, can reach it over the Chrome DevTools Protocol, and
 * stopping exactly what was launched. What `up` started is recorded in the
 * instance's session.json; evidence goes to a folder that `down` leaves.
 */
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { chromium, type Browser, type Page } from "@playwright/test"
import { UsageError } from "./args.ts"
import { withoutCredentials } from "./env.ts"

export const REPO = path.resolve(import.meta.dir, "../..")
const ROOT = path.join(REPO, ".verify-runbooks")

export interface Session {
  readonly instance: string
  /** The process group `up` started: xvfb-run or Electron, and everything under it. */
  readonly pid: number
  readonly recorderPid?: number | undefined
  readonly port: number
  readonly runbook: string
  readonly simulate: boolean
  readonly startedAt: string
  readonly stateDir: string
  readonly evidenceDir: string
}

export const stateDir = (instance: string) => path.join(ROOT, "state", instance)
const sessionFile = (instance: string) => path.join(stateDir(instance), "session.json")
export const consoleLog = (instance: string) => path.join(stateDir(instance), "console.jsonl")
export const mainLog = (instance: string) => path.join(stateDir(instance), "main.log")

export function readSession(instance: string): Session | undefined {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(instance), "utf8")) as Session
  } catch {
    return undefined
  }
}

export function requireSession(instance: string): Session {
  const session = readSession(instance)
  if (!session) {
    throw new UsageError(
      `No app is running as instance "${instance}".`,
      "Start one: control-runbooks up testdata/feature-demos/tf-module --simulate",
    )
  }
  return session
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })

/** The newest modification time of any file under the folders, skipping node_modules. */
function newest(dirs: readonly string[]): number {
  let latest = 0
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else latest = Math.max(latest, fs.statSync(full).mtimeMs)
    }
  }
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir)
  return latest
}

const BUILT = path.join(REPO, "dist/main/index.js")

/** Whether dist/ is older than the sources it's built from. */
export function buildIsStale(): boolean {
  if (!fs.existsSync(BUILT)) return true
  const sources = ["electron", "src", "web/src"].map((d) => path.join(REPO, d))
  return newest(sources) > fs.statSync(BUILT).mtimeMs
}

const until = async <T>(what: () => Promise<T | undefined>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await what().catch(() => undefined)
    if (value !== undefined) return value
    await new Promise((r) => {
      setTimeout(r, 250)
    })
  }
  return undefined
}

/** The app's window, over CDP. The caller closes the browser, which leaves the app running. */
export async function connect(session: Session): Promise<{ browser: Browser; page: Page }> {
  if (!alive(session.pid)) {
    throw new UsageError(
      `The app for instance "${session.instance}" isn't running any more (pid ${session.pid}).`,
      `See why with control-runbooks logs --source main, then control-runbooks down and up again.`,
    )
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`)
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("/renderer/index.html"))
  if (!page) {
    await browser.close()
    throw new UsageError("Connected, but found no Runbooks window.", "Run control-runbooks doctor.")
  }
  return { browser, page }
}

export interface UpOptions {
  readonly instance: string
  readonly runbook: string
  readonly simulate: boolean
  readonly realHome: boolean
  readonly build: boolean
}

export async function up(options: UpOptions): Promise<Session & { built: boolean }> {
  const existing = readSession(options.instance)
  if (existing && alive(existing.pid)) {
    throw new UsageError(
      `Instance "${options.instance}" is already running on ${existing.runbook}.`,
      "Drive it, stop it with control-runbooks down, or start another with --instance <name>.",
    )
  }
  const runbook = path.resolve(REPO, options.runbook)
  if (!fs.existsSync(runbook)) {
    throw new UsageError(`No runbook at ${runbook}.`, "Pass a runbook folder or .mdx file.")
  }
  let built = false
  if (options.build && buildIsStale()) {
    const result = spawnSync("bunx", ["electron-vite", "build"], { cwd: REPO, encoding: "utf8" })
    if (result.status !== 0) {
      throw new UsageError(
        "The build failed, so there's no app to launch.",
        (result.stderr || result.stdout).split("\n").slice(-15).join("\n"),
      )
    }
    built = true
  }

  const dir = stateDir(options.instance)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "home"), { recursive: true })
  const startedAt = new Date().toISOString()
  const evidenceDir = path.join(
    ROOT,
    "evidence",
    `${startedAt.replace(/[:.]/g, "-")}-${options.instance}`,
  )
  fs.mkdirSync(evidenceDir, { recursive: true })

  const port = await freePort()
  const electron = path.join(REPO, "node_modules/.bin/electron")
  const appArgs = [
    BUILT,
    `--remote-debugging-port=${port}`,
    "--use-mock-keychain",
    `--user-data-dir=${path.join(dir, "user-data")}`,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ...(options.simulate ? ["--simulate"] : []),
    runbook,
  ]
  // Without a display (a container or CI), a virtual one hosts the window.
  const headless = process.platform === "linux" && !process.env.DISPLAY
  const [cmd, args] = headless
    ? ["xvfb-run", ["-a", "-s", "-screen 0 1440x1000x24", electron, ...appArgs]]
    : [electron, appArgs]
  const out = fs.openSync(mainLog(options.instance), "a")
  const child = spawn(cmd, args, {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...(options.realHome
        ? process.env
        : { ...withoutCredentials(process.env), HOME: path.join(dir, "home") }),
      ELECTRON_NO_UPDATER: "1",
      RUNBOOKS_TELEMETRY_DISABLE: "1",
    },
  })
  child.unref()
  const session: Session = {
    instance: options.instance,
    pid: child.pid!,
    port,
    runbook: path.relative(REPO, runbook),
    simulate: options.simulate,
    startedAt,
    stateDir: dir,
    evidenceDir,
  }
  fs.writeFileSync(sessionFile(options.instance), JSON.stringify(session, null, 2))

  // Usable means the window rendered the runbook's header, not just that the port answers.
  const ready = await until(async () => {
    const { browser, page } = await connect(session)
    try {
      return (await page.getByRole("banner").count()) > 0 ? true : undefined
    } finally {
      await browser.close()
    }
  }, 60_000)
  if (!ready) {
    const tail = fs.readFileSync(mainLog(options.instance), "utf8").split("\n").slice(-10)
    throw new UsageError("The app didn't become usable within 60s.", tail.join("\n"))
  }

  const recorder = spawn(
    process.execPath,
    [path.join(import.meta.dir, "cli.ts"), "_recorder", "--instance", options.instance],
    { cwd: REPO, detached: true, stdio: "ignore" },
  )
  recorder.unref()
  const recorded = { ...session, recorderPid: recorder.pid }
  fs.writeFileSync(sessionFile(options.instance), JSON.stringify(recorded, null, 2))
  return { ...recorded, built }
}

/** Stops what `up` started, by its process group, and removes the scratch state; evidence stays. */
export function down(instance: string, dryRun: boolean) {
  const session = readSession(instance)
  const dir = stateDir(instance)
  if (!session) {
    return { stopped: [], removed: fs.existsSync(dir) ? [dir] : [], note: "Nothing was running." }
  }
  const pids = [session.pid, session.recorderPid].filter(
    (pid): pid is number => pid !== undefined && alive(pid),
  )
  if (dryRun)
    return { dryRun: true, wouldStop: pids, wouldRemove: [dir], keeps: session.evidenceDir }
  // The logs are evidence too, so they move next to the screenshots first.
  for (const log of [mainLog(instance), consoleLog(instance)]) {
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(session.evidenceDir, path.basename(log)))
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      process.kill(pid, "SIGTERM")
    }
  }
  const deadline = Date.now() + 5000
  while (pids.some(alive) && Date.now() < deadline) spawnSync("sleep", ["0.2"])
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { stopped: pids, removed: [dir], evidence: session.evidenceDir }
}

export async function doctor(instance: string) {
  const checks: { check: string; ok: boolean; detail: string }[] = []
  // Where the app is, as opposed to whether it's healthy: neither way fails the check.
  const state: Record<string, string> = {}
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail })
  const stale = buildIsStale()
  add(
    "build",
    !stale,
    stale ? "dist/ is older than the sources: down, then up rebuilds it" : "dist/ is current",
  )
  const session = readSession(instance)
  if (!session) {
    add("session", false, `no instance "${instance}": run control-runbooks up`)
    return { ok: false, checks }
  }
  add("process", alive(session.pid), `pid ${session.pid}`)
  add(
    "recorder",
    session.recorderPid !== undefined && alive(session.recorderPid),
    "console messages are being saved to the log",
  )
  try {
    const { browser, page } = await connect(session)
    try {
      add("window", true, `${await page.title()} at ${page.url()}`)
      const trust = await page.getByRole("button", { name: "I trust this Runbook" }).count()
      state.trusted = trust === 0 ? "yes" : "no: run control-runbooks setup trust"
      const simulation = await page.getByTestId("simulation-bar").count()
      add(
        "simulation",
        simulation > 0 === session.simulate,
        session.simulate ? "simulation bar showing" : "no simulation",
      )
    } finally {
      await browser.close()
    }
  } catch (err) {
    add("window", false, err instanceof Error ? err.message : String(err))
  }
  return {
    ok: checks.every((c) => c.ok),
    runbook: session.runbook,
    port: session.port,
    checks,
    state,
  }
}
