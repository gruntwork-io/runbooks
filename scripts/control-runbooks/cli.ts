#!/usr/bin/env bun
/**
 * control-runbooks: an agent's hands and eyes on a running Runbooks app.
 * Each command is one user action or one read, prints one JSON object, and
 * exits; the app keeps running between commands. See
 * .claude/skills/verify-runbooks/SKILL.md for how to use it.
 */
import * as fs from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { commandSpec, describeTarget, helpText, parse, UsageError, type Parsed } from "./args.ts"
import { capture, journal } from "./evidence.ts"
import {
  connect,
  consoleLog,
  doctor,
  down,
  mainLog,
  readSession,
  requireSession,
  up,
  type Session,
} from "./session.ts"
import { run as runSetup, sequence } from "./setups.ts"
import { resolve, scopeOf, snapshotOf } from "./target.ts"

type Result = Record<string, unknown>

const str = (p: Parsed, name: string) =>
  typeof p.flags[name] === "string" ? (p.flags[name] as string) : undefined

async function withPage<T>(session: Session, fn: (page: Page) => Promise<T>): Promise<T> {
  const { browser, page } = await connect(session)
  try {
    return await fn(page)
  } finally {
    // Closing a CDP connection detaches from the app; it doesn't close the app.
    await browser.close()
  }
}

/** Does one action on the target, then saves a screenshot and a journal line. */
async function act(
  p: Parsed,
  session: Session,
  label: string,
  action: (page: Page, element: Locator | undefined) => Promise<void>,
): Promise<Result> {
  return withPage(session, async (page) => {
    const element = p.target && p.command !== "press" ? await resolve(page, p.target) : undefined
    const what = p.target ? describeTarget(p.target) : "the focused element"
    if (p.flags["dry-run"]) return { dryRun: true, wouldDo: `${label} on ${what}` }
    await action(page, element)
    await page.waitForTimeout(Number(str(p, "settle") ?? 400))
    const screenshot = await capture(session, page, `${label} ${what}`)
    journal(session, { command: p.command, target: what, label, screenshot })
    return { did: `${label} on ${what}`, screenshot }
  })
}

async function dispatch(p: Parsed): Promise<Result> {
  const instance = str(p, "instance") ?? "default"
  if (p.flags.help) return { help: helpText(p.command) }
  switch (p.command) {
    case "help":
      return { help: helpText(p.positionals[0]) }
    case "up": {
      const runbook = p.positionals[0]
      if (!runbook) throw new UsageError("Name the runbook to open.", commandSpec("up").example)
      const session = await up({
        instance,
        runbook,
        simulate: p.flags.simulate === true,
        realHome: p.flags["real-home"] === true,
        build: p.flags["no-build"] !== true,
      })
      return {
        ...session,
        next: "control-runbooks doctor, then control-runbooks setup trust",
      }
    }
    case "doctor":
      return doctor(instance)
    case "down":
      return down(instance, p.flags["dry-run"] === true)
    case "logs": {
      const session = readSession(instance)
      const source = str(p, "source") ?? "console"
      const file = source === "main" ? mainLog(instance) : consoleLog(instance)
      const fallback = session ? `${session.evidenceDir}/${file.split("/").pop()}` : undefined
      const at = fs.existsSync(file)
        ? file
        : fallback && fs.existsSync(fallback)
          ? fallback
          : undefined
      if (!at) throw new UsageError(`No ${source} log for instance "${instance}" yet.`)
      let lines = fs.readFileSync(at, "utf8").split("\n").filter(Boolean)
      if (p.flags.errors) {
        lines = lines.filter((l) =>
          source === "main"
            ? /error|warn|fatal/i.test(l)
            : /"type":"(error|warning|pageerror)"/.test(l),
        )
      }
      const tail = Number(str(p, "tail") ?? 50)
      return { file: at, lines: lines.slice(-tail) }
    }
  }

  const session = requireSession(instance)
  switch (p.command) {
    case "setup": {
      const [name, ...args] = p.positionals
      const seq = sequence(name)
      return withPage(session, async (page) => {
        const result = await runSetup(page, seq.steps(args))
        const screenshot = await capture(session, page, `setup-${name}`)
        journal(session, { command: "setup", sequence: name, args, ...result, screenshot })
        return result.ok
          ? { ok: true, sequence: name, endState: seq.endState, done: result.done, screenshot }
          : {
              ...result,
              error: `Setup "${name}" stopped at: ${result.failedAt}.`,
              hint: `Expected: ${result.expected}. Look at the screenshot, then control-runbooks snapshot.`,
              screenshot,
            }
      })
    }
    case "snapshot":
      return withPage(session, async (page) => {
        const scope = p.target ? await resolveScope(page, p) : page
        return { snapshot: (await snapshotOf(scope)).split("\n") }
      })
    case "screenshot":
      return withPage(session, async (page) => {
        const element = p.target ? await resolveScope(page, p) : undefined
        const label = p.positionals[0] ?? "screenshot"
        const file = await capture(
          session,
          page,
          label,
          element && !("goto" in element) ? element : undefined,
        )
        journal(session, { command: "screenshot", label, screenshot: file })
        return { screenshot: file }
      })
    case "click":
      return act(p, session, "click", (_page, el) => el!.click())
    case "fill": {
      const value = p.positionals[0]
      if (value === undefined)
        throw new UsageError("fill needs a value.", commandSpec("fill").example)
      return act(p, session, `fill "${value}"`, (_page, el) => el!.fill(value))
    }
    case "type": {
      const text = p.positionals[0]
      if (text === undefined) throw new UsageError("type needs text.", commandSpec("type").example)
      return act(p, session, `type "${text}"`, (_page, el) =>
        el!.pressSequentially(text, { delay: 40 }),
      )
    }
    case "select": {
      const option = p.positionals[0]
      if (option === undefined)
        throw new UsageError("select needs an option.", commandSpec("select").example)
      return act(p, session, `select "${option}"`, async (_page, el) => {
        await el!.selectOption({ label: option }).catch(() => el!.selectOption(option))
      })
    }
    case "press": {
      const key = p.positionals[0]
      if (!key) throw new UsageError("press needs a key.", commandSpec("press").example)
      return act(p, session, `press ${key}`, async (page) => {
        if (p.target) await (await resolve(page, p.target)).press(key)
        else await page.keyboard.press(key)
      })
    }
    case "wait": {
      const timeout = Number(str(p, "timeout") ?? 10_000)
      const gone = p.flags.gone === true
      return withPage(session, async (page) => {
        const scope = await scopeOf(page, p.target)
        const target = p.target!
        const locator =
          target.role !== undefined
            ? scope.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
                ...(target.name !== undefined ? { name: target.name } : {}),
                exact: target.exact,
              })
            : target.label !== undefined
              ? scope.getByLabel(target.label, { exact: target.exact })
              : target.text !== undefined
                ? scope.getByText(target.text, { exact: target.exact })
                : target.testid !== undefined
                  ? scope.getByTestId(target.testid)
                  : scope.locator(target.css!)
        const started = Date.now()
        try {
          await locator.first().waitFor({ state: gone ? "hidden" : "visible", timeout })
        } catch {
          // Says what's there instead, when the element never showed.
          const there = gone
            ? undefined
            : await resolve(page, target).then(
                () => undefined,
                (err: unknown) => (err instanceof UsageError ? err.hint : undefined),
              )
          throw new UsageError(
            `${describeTarget(target)} didn't ${gone ? "disappear" : "show"} within ${timeout}ms.`,
            there ?? "Take a screenshot or snapshot to see where the app is.",
          )
        }
        return {
          waited: describeTarget(target),
          state: gone ? "gone" : "visible",
          ms: Date.now() - started,
        }
      })
    }
    case "eval": {
      const expression = p.positionals.join(" ")
      if (!expression)
        throw new UsageError("eval needs an expression.", commandSpec("eval").example)
      return withPage(session, async (page) => ({ value: await page.evaluate(expression) }))
    }
    case "cdp": {
      const [method, params] = p.positionals
      if (!method) throw new UsageError("cdp needs a method.", commandSpec("cdp").example)
      return withPage(session, async (page) => {
        const client = await page.context().newCDPSession(page)
        const result = await client.send(
          method as Parameters<typeof client.send>[0],
          params ? JSON.parse(params) : undefined,
        )
        return { result }
      })
    }
  }
  throw new UsageError(`${p.command} isn't wired up.`)
}

async function resolveScope(page: Page, p: Parsed): Promise<Page | Locator> {
  const t = p.target!
  const onlyWithin =
    t.role === undefined &&
    t.label === undefined &&
    t.text === undefined &&
    t.testid === undefined &&
    t.css === undefined
  return onlyWithin ? scopeOf(page, t) : resolve(page, t)
}

/**
 * Started by `up` and left running: saves the window's console messages and
 * uncaught errors, which only reach a connected client, to the instance's log.
 */
async function recorder(instance: string) {
  const session = requireSession(instance)
  const { browser, page } = await connect(session)
  const log = (entry: Record<string, unknown>) =>
    fs.appendFileSync(
      consoleLog(instance),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    )
  page.on("console", (m) => log({ type: m.type(), text: m.text() }))
  page.on("pageerror", (e) => log({ type: "pageerror", text: e.message }))
  await new Promise<void>((done) => {
    browser.on("disconnected", () => done())
  })
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === "_recorder") {
    await recorder(argv[2] ?? "default")
    return
  }
  let parsed: Parsed | undefined
  try {
    parsed = parse(argv)
    const result = await dispatch(parsed)
    if (typeof result.help === "string") {
      process.stdout.write(`${result.help}\n`)
      return
    }
    const ok = result.ok !== false
    process.stdout.write(`${JSON.stringify({ ok, command: parsed.command, ...result }, null, 2)}\n`)
    if (!ok) process.exitCode = 1
  } catch (err) {
    const usage = err instanceof UsageError
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          command: parsed?.command ?? argv[0],
          error: usage
            ? err.message
            : err instanceof Error
              ? err.message.split("\n")[0]
              : String(err),
          ...(usage && err.hint ? { hint: err.hint } : {}),
        },
        null,
        2,
      )}\n`,
    )
    process.exitCode = 1
  }
}

await main()
