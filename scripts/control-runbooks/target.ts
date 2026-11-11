/**
 * Finding the element a command names, and, when none or several match,
 * saying which elements are there instead, so the caller's next try is right.
 */
import type { Locator, Page } from "@playwright/test"
import { closest, describeTarget, UsageError, type Target } from "./args.ts"

export interface AriaNode {
  readonly role: string
  readonly name: string
}

/** The role and name of each node in a Playwright aria snapshot. */
export function ariaNodes(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = []
  for (const line of snapshot.split("\n")) {
    const match = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line)
    if (match) nodes.push({ role: match[1]!, name: (match[2] ?? "").replace(/\\"/g, '"') })
  }
  return nodes
}

/** The page, or the block the target is scoped to. */
export async function scopeOf(page: Page, target: Target | undefined): Promise<Page | Locator> {
  if (!target?.within) return page
  const block = page.getByTestId(target.within)
  if ((await block.count()) === 0) {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll(".runbook-block")]
        .map((el) => el.closest("[data-testid]")?.getAttribute("data-testid"))
        .filter((id): id is string => Boolean(id)),
    )
    const near = closest(target.within, ids)
    throw new UsageError(
      `No block "${target.within}" on the page.`,
      ids.length
        ? `Blocks here: ${(near.length ? near : ids).join(", ")}.`
        : "No blocks rendered yet.",
    )
  }
  return block.first()
}

/** The scope's accessibility tree, as Playwright's aria snapshot YAML. */
export const snapshotOf = (scope: Page | Locator) =>
  "goto" in scope ? scope.locator("body").ariaSnapshot() : scope.ariaSnapshot()

function locatorIn(scope: Page | Locator, t: Target): Locator {
  const exact = t.exact
  if (t.role !== undefined) {
    return scope.getByRole(t.role as Parameters<Page["getByRole"]>[0], {
      ...(t.name !== undefined ? { name: t.name } : {}),
      exact,
    })
  }
  if (t.label !== undefined) return scope.getByLabel(t.label, { exact })
  if (t.text !== undefined) return scope.getByText(t.text, { exact })
  if (t.testid !== undefined) return scope.getByTestId(t.testid)
  return scope.locator(t.css!)
}

/** What a user would call the element: its accessible name, else its text. */
const describe = (el: Locator) =>
  el.evaluate((node) => {
    const aria = node.getAttribute("aria-label")
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim()
    return `${node.getAttribute("role") ?? node.tagName.toLowerCase()} "${(aria ?? text).slice(0, 60)}"`
  })

/**
 * The one element the target names. Fails with the closest names in scope
 * when none match, and with the matches when several do.
 */
export async function resolve(page: Page, target: Target): Promise<Locator> {
  const scope = await scopeOf(page, target)
  const all = locatorIn(scope, target)
  const count = await all.count()
  if (target.nth !== undefined) {
    if (target.nth < count) return all.nth(target.nth)
    throw new UsageError(
      `${describeTarget(target)}: only ${count} match${count === 1 ? "es" : ""}.`,
      count ? `Use --nth 0 to ${count - 1}.` : undefined,
    )
  }
  if (count === 1) return all
  if (count > 1) {
    const matches = await Promise.all(
      (await all.all()).slice(0, 8).map((el, i) => describe(el).then((d) => `#${i} ${d}`)),
    )
    throw new UsageError(
      `${describeTarget(target)} matches ${count} elements.`,
      `Narrow it with --exact, --within <block-id>, or --nth: ${matches.join("; ")}`,
    )
  }
  const nodes = ariaNodes(await snapshotOf(scope).catch(() => ""))
  const wanted = target.name ?? target.label ?? target.text ?? target.testid ?? target.css ?? ""
  const pool = nodes
    .filter((n) => n.name && (target.role === undefined || n.role === target.role))
    .map((n) => n.name)
  const near = closest(wanted, pool)
  const sameRole = target.role ? nodes.filter((n) => n.role === target.role && n.name) : []
  throw new UsageError(
    `Nothing matches ${describeTarget(target)}.`,
    near.length
      ? `Closest: ${near.map((n) => `"${n}"`).join(", ")}.`
      : sameRole.length
        ? `${target.role} elements here: ${sameRole
            .slice(0, 10)
            .map((n) => `"${n.name}"`)
            .join(", ")}.`
        : "Run control-runbooks snapshot to see what's on screen; a hidden tab's content doesn't match.",
  )
}
