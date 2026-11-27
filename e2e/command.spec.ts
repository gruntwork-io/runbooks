/**
 * Command in the window, end to end: each of Command's test runbooks
 * (blocks/command/testdata) opened in place and trusted through the trust
 * prompt, then run in the window as its runbook_test.yml runs it, block by
 * block: each block's status, log and outputs as the window shows them, and
 * what its script left on disk. The stop runbook's test is
 * packages/cli/src/main.test.ts's: it stops the run, here with Cancel.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

const testdata = (name: string) =>
  path.join(import.meta.dirname, "..", "blocks", "command", "testdata", name)

/** Trusts the runbook through the trust prompt. */
async function trust(page: Page) {
  const prompt = page.getByRole("region", { name: "Trust this runbook" })
  await prompt.getByRole("button", { name: "I trust this runbook" }).click()
  await expect(prompt).toHaveCount(0)
}

/** Whether `pid` is a live process: a zombie waiting to be reaped has ended. */
function alive(pid: number): boolean {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout
  return stat.trim() !== "" && !stat.trim().startsWith("Z")
}

test.describe("Command in the window", () => {
  test("runs end-to-end's blocks in order: each one's status, its log and outputs, and the file setup makes", async ({
    launch,
    userDataDir,
  }) => {
    const { page } = await launch({ args: [testdata("end-to-end")] })
    const setup = page.locator("#runbook-block-setup")
    const consume = page.locator("#runbook-block-consume")
    const fails = page.locator("#runbook-block-fails")
    await trust(page)

    await expect(setup.locator(".block-status")).toHaveText("Ready")
    // consume reads setup's output and variables.
    await expect(consume.getByText("Waiting for:")).toBeVisible()
    await expect(consume.getByRole("button", { name: "Run" })).toHaveCount(0)

    await setup.getByRole("button", { name: "Run" }).click()
    await expect(setup.locator(".block-status")).toHaveText("Done")
    // A log_info line: its timestamp, its level, and what it says.
    await expect(setup.getByLabel("Log")).toHaveText(/^\[[\dTZ:-]+\] \[INFO\] +setting up\n$/)
    await expect(setup.getByLabel("Outputs").locator("dt")).toHaveText(["region"])
    await expect(setup.getByLabel("Outputs").locator("dd")).toHaveText(["us-east-1"])
    const made = fs
      .readdirSync(userDataDir, { recursive: true, encoding: "utf8" })
      .filter((file) => path.basename(file) === "made-by-setup.txt")
    expect(made).toEqual([expect.stringMatching(/^v0\/sessions\/dirs\/[\w-]+\/generated\//)])
    expect(fs.readFileSync(path.join(userDataDir, made[0]!), "utf8")).toBe("made\n")

    await expect(consume.locator(".block-status")).toHaveText("Ready")
    await consume.getByRole("button", { name: "Run" }).click()
    await expect(consume.locator(".block-status")).toHaveText("Done")
    await expect(consume.getByLabel("Outputs").locator("dt")).toHaveText(["seen"])
    await expect(consume.getByLabel("Outputs").locator("dd")).toHaveText(["eu-west-2/us-east-1"])

    await fails.getByRole("button", { name: "Run" }).click()
    await expect(fails.locator(".block-status")).toHaveText(
      "Failed: The script exited with code 3.",
    )
    await expect(fails.getByLabel("Outputs")).toHaveCount(0)
    // A failed block can run again.
    await expect(fails.getByRole("button", { name: "Run" })).toBeVisible()
  })

  test("stops a running Command with Cancel: it says it was cancelled, and none of its processes outlives it", async ({
    launch,
  }, testInfo) => {
    // The script writes its own pid and its two sleeps' here (scripts/sleeps.sh).
    const pidsFile = testInfo.outputPath("pids")
    const pids = () =>
      fs.existsSync(pidsFile)
        ? fs.readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number)
        : []
    try {
      const { page } = await launch({
        args: [testdata("stop")],
        env: { SLEEPS_PIDS_FILE: pidsFile },
      })
      const sleeps = page.locator("#runbook-block-sleeps")
      await trust(page)

      await sleeps.getByRole("button", { name: "Run" }).click()
      await expect(sleeps.locator(".block-status")).toHaveText("Running")
      await expect.poll(() => pids().length).toBe(3)
      await expect(sleeps.getByRole("button", { name: "Run" })).toHaveCount(0)

      await sleeps.getByRole("button", { name: "Cancel" }).click()
      await expect(sleeps.locator(".block-status")).toHaveText("Cancelled")
      // The block answered once its processes had ended.
      expect(pids().filter(alive)).toEqual([])
      await expect(sleeps.getByRole("button", { name: "Run" })).toBeVisible()
    } finally {
      // A failed test may leave the script's processes running.
      for (const pid of pids().filter(alive)) process.kill(pid, "SIGKILL")
    }
  })
})
