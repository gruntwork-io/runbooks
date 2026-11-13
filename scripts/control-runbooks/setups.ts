/**
 * Named setup sequences: the fixed steps that bring the app to where a
 * journey starts. Each step acts the way a user would and then checks the
 * state it should leave; the sequence stops at the first step whose state
 * doesn't appear. They're preconditions, never the behavior under test.
 */
import type { Page } from "@playwright/test"
import { UsageError } from "./args.ts"

interface Step {
  /** What the step does, as the user would put it. */
  readonly does: string
  /** The state it leaves, as the user would see it. */
  readonly leaves: string
  readonly act: (page: Page) => Promise<void>
  readonly check: (page: Page) => Promise<boolean>
}

export interface Sequence {
  readonly name: string
  readonly usage: string
  readonly endState: string
  readonly steps: (args: readonly string[]) => Step[]
}

const trustStep: Step = {
  does: "Click I trust this Runbook, if the runbook asks",
  leaves: "No trust prompt, so the blocks can run",
  act: async (page) => {
    const button = page.getByRole("button", { name: "I trust this Runbook" })
    if (await button.count()) await button.click()
  },
  check: async (page) =>
    (await page.getByRole("button", { name: "I trust this Runbook" }).count()) === 0,
}

export const SEQUENCES: readonly Sequence[] = [
  {
    name: "trust",
    usage: "setup trust",
    endState: "The runbook is trusted: no trust prompt, blocks can run.",
    steps: () => [trustStep],
  },
  {
    name: "scenario",
    usage: "setup scenario <name-or-label>",
    endState:
      "The simulation bar's Scenario picker shows the scenario, and its description shows below.",
    steps: ([name]) => {
      if (!name)
        throw new UsageError("Name a scenario.", "control-runbooks setup scenario group-exists")
      const picker = (page: Page) => page.getByLabel("Simulation scenario")
      return [
        {
          does: `Pick "${name}" in the simulation bar's Scenario picker`,
          leaves: `The picker shows ${name}`,
          act: async (page) => {
            const options = await picker(page)
              .locator("option")
              .evaluateAll((els) =>
                els.map((el) => ({
                  value: (el as HTMLOptionElement).value,
                  label: el.textContent ?? "",
                })),
              )
            const match = options.find((o) => o.value === name || o.label === name)
            if (!match) {
              throw new UsageError(
                `simulation.yml has no scenario "${name}".`,
                `Scenarios: ${options.map((o) => `${o.value} (${o.label})`).join(", ")}`,
              )
            }
            await picker(page).selectOption(match.value)
          },
          check: async (page) => {
            const value = await picker(page).inputValue()
            const label = await picker(page).locator("option:checked").textContent()
            return value === name || label === name
          },
        },
      ]
    },
  },
  {
    name: "group-form",
    usage: "setup group-form [block-id]",
    endState:
      "The Google Group block's form has example.com, platform, Platform team, and Sam Rivera as an owner, with no input needing a fix.",
    steps: ([blockId = "group"]) => {
      const block = (page: Page) => page.getByTestId(blockId)
      return [
        trustStep,
        {
          does: "Type example in Organization and pick example.com",
          leaves: "Organization shows example.com",
          act: async (page) => {
            await block(page).getByLabel("Organization").fill("example")
            await block(page)
              .getByRole("option", { name: /example\.com/ })
              .first()
              .click()
          },
          check: async (page) =>
            (await block(page).getByLabel("Organization").inputValue()).includes("example.com"),
        },
        {
          does: "Fill Group email with platform",
          leaves: "Group email shows platform, with @example.com after it",
          act: (page) => block(page).getByLabel("Group email").fill("platform"),
          check: async (page) =>
            (await block(page).getByLabel("Group email").inputValue()) === "platform",
        },
        {
          does: "Fill Name with Platform team",
          leaves: "Name shows Platform team",
          act: (page) => block(page).getByLabel("Name", { exact: true }).fill("Platform team"),
          check: async (page) =>
            (await block(page).getByLabel("Name", { exact: true }).inputValue()) ===
            "Platform team",
        },
        {
          does: 'Click Add "Sam Rivera" as an owner',
          leaves: "Sam Rivera is listed under Owners",
          act: (page) =>
            block(page)
              .getByRole("button", { name: /as an owner/ })
              .click(),
          check: async (page) => (await block(page).getByText("sam@example.com").count()) > 0,
        },
      ]
    },
  },
  {
    name: "group-code",
    usage: "setup group-code [block-id]",
    endState:
      "The group-form setup, then Generate: the Google Group block lists the code it generated, and the TerragruntApply block below can plan it.",
    steps: ([blockId = "group"]) => {
      const block = (page: Page) => page.getByTestId(blockId)
      const form = sequence("group-form").steps([blockId])
      return [
        ...form,
        {
          does: "Click Generate",
          leaves: "The block lists the code's files",
          act: (page) => block(page).getByRole("button", { name: "Generate" }).click(),
          check: async (page) => (await block(page).getByTestId("tf-module-generated").count()) > 0,
        },
      ]
    },
  },
]

export function sequence(name: string | undefined): Sequence {
  const found = SEQUENCES.find((s) => s.name === name)
  if (found) return found
  throw new UsageError(
    name ? `No setup sequence "${name}".` : "Name a setup sequence.",
    `Sequences: ${SEQUENCES.map((s) => `${s.usage} (${s.endState})`).join(" | ")}`,
  )
}

/** Runs the steps in order, stopping at the first whose state doesn't appear. */
export async function run(page: Page, steps: readonly Step[]) {
  const done: string[] = []
  for (const step of steps) {
    try {
      await step.act(page)
    } catch (err) {
      if (err instanceof UsageError) throw err
      return {
        ok: false as const,
        done,
        failedAt: step.does,
        expected: step.leaves,
        error: String(err),
      }
    }
    const deadline = Date.now() + 5000
    let ok = false
    while (!ok && Date.now() < deadline) {
      ok = await step.check(page).catch(() => false)
      if (!ok) await page.waitForTimeout(200)
    }
    if (!ok) return { ok: false as const, done, failedAt: step.does, expected: step.leaves }
    done.push(step.does)
  }
  return { ok: true as const, done }
}
