/**
 * The evidence a run leaves: a numbered screenshot after each action, and a
 * journal line saying what was done and what happened, in the instance's
 * evidence folder, which outlives `down`.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { Locator, Page } from "@playwright/test"
import type { Session } from "./session.ts"

/** A file-name-safe slug of what was done, such as `click-tab-code`. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "step"
  )
}

/** The next numbered file name in the folder, such as `007-click-tab-code.png`. */
export function nextName(existing: readonly string[], label: string, ext: string): string {
  const numbers = existing.map((f) => Number(/^(\d{3})-/.exec(f)?.[1] ?? 0))
  const next = Math.max(0, ...numbers) + 1
  return `${String(next).padStart(3, "0")}-${slug(label)}.${ext}`
}

export async function capture(
  session: Session,
  page: Page,
  label: string,
  element?: Locator,
): Promise<string> {
  const file = path.join(
    session.evidenceDir,
    nextName(fs.readdirSync(session.evidenceDir), label, "png"),
  )
  if (element) await element.screenshot({ path: file })
  else await page.screenshot({ path: file })
  return file
}

export function journal(session: Session, entry: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(session.evidenceDir, "journal.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  )
}
