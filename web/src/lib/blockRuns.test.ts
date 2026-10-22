import { describe, it, expect } from "vitest"
import { computeRunBlockers, isRunBlocked } from "./blockRuns"
import type { BlockRun, BlockRunStatus } from "@/contexts/BlockRunsContext.types"

function run(blockId: string, status: BlockRunStatus, exclusive = false): BlockRun {
  return { blockId, status, exclusive }
}

/** Keys runs the way the provider does: hyphens in the id become underscores. */
function runsOf(...runs: BlockRun[]): Record<string, BlockRun> {
  return Object.fromEntries(runs.map((r) => [r.blockId.replace(/-/g, "_"), r]))
}

const base = {
  blockId: "deploy",
  exclusive: false,
  outputDependencyIds: [] as string[],
  dependsOn: [] as string[],
}

describe("computeRunBlockers", () => {
  it("lets unrelated blocks run at the same time", () => {
    const blockers = computeRunBlockers({
      ...base,
      runs: runsOf(run("deploy", "pending"), run("lint", "running")),
    })

    expect(blockers).toEqual({ running: [], notSucceeded: [] })
    expect(isRunBlocked(blockers)).toBe(false)
  })

  it("waits for a running block whose outputs the script references", () => {
    const build = run("build-image", "running")
    const blockers = computeRunBlockers({
      ...base,
      // As a template names it: {{ .outputs.build_image.tag }}
      outputDependencyIds: ["build_image"],
      runs: runsOf(run("deploy", "pending"), build),
    })

    expect(blockers.running).toEqual([{ run: build, reason: "dependency" }])
    expect(isRunBlocked(blockers)).toBe(true)
  })

  it("does not wait for an output dependency that has finished", () => {
    const blockers = computeRunBlockers({
      ...base,
      outputDependencyIds: ["build_image"],
      runs: runsOf(run("deploy", "pending"), run("build-image", "success")),
    })

    expect(isRunBlocked(blockers)).toBe(false)
  })

  it.each<BlockRunStatus>(["pending", "fail"])(
    "waits for a dependsOn block whose latest run is %s",
    (status) => {
      const blockers = computeRunBlockers({
        ...base,
        dependsOn: ["login"],
        runs: runsOf(run("deploy", "pending"), run("login", status)),
      })

      expect(blockers).toEqual({ running: [], notSucceeded: ["login"] })
    },
  )

  it("waits for a dependsOn block that is running, without also listing it as not succeeded", () => {
    const login = run("login", "running")
    const blockers = computeRunBlockers({
      ...base,
      dependsOn: ["login"],
      runs: runsOf(run("deploy", "pending"), login),
    })

    expect(blockers).toEqual({ running: [{ run: login, reason: "dependency" }], notSucceeded: [] })
  })

  it.each<BlockRunStatus>(["success", "warn"])(
    "is satisfied by a dependsOn block that finished with %s",
    (status) => {
      const blockers = computeRunBlockers({
        ...base,
        dependsOn: ["login"],
        runs: runsOf(run("deploy", "pending"), run("login", status)),
      })

      expect(isRunBlocked(blockers)).toBe(false)
    },
  )

  it("waits for a dependsOn id that names no block", () => {
    const blockers = computeRunBlockers({
      ...base,
      dependsOn: ["typo"],
      runs: runsOf(run("deploy", "pending")),
    })

    expect(blockers.notSucceeded).toEqual(["typo"])
  })

  it("matches a dependsOn id written with hyphens or underscores", () => {
    const blockers = computeRunBlockers({
      ...base,
      dependsOn: ["build_image"],
      runs: runsOf(run("deploy", "pending"), run("build-image", "success")),
    })

    expect(isRunBlocked(blockers)).toBe(false)
  })

  it("keeps every block waiting while an exclusive block runs", () => {
    const migrate = run("migrate", "running", true)
    const blockers = computeRunBlockers({
      ...base,
      runs: runsOf(run("deploy", "pending"), migrate),
    })

    expect(blockers.running).toEqual([{ run: migrate, reason: "exclusive" }])
  })

  it("keeps an exclusive block waiting while any other block runs", () => {
    const lint = run("lint", "running")
    const blockers = computeRunBlockers({
      ...base,
      exclusive: true,
      runs: runsOf(run("deploy", "pending", true), lint, run("build-image", "success")),
    })

    expect(blockers.running).toEqual([{ run: lint, reason: "exclusive" }])
  })

  it("never lists the block itself", () => {
    const blockers = computeRunBlockers({
      ...base,
      exclusive: true,
      outputDependencyIds: ["deploy"],
      runs: runsOf(run("deploy", "running", true)),
    })

    expect(blockers.running).toEqual([])
  })
})
