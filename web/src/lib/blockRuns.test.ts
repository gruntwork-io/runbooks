import { describe, it, expect } from "vitest"
import { computeRunBlockers, isRunBlocked, showWhenBlockState } from "./blockRuns"
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

describe("showWhenBlockState", () => {
  const showBase = {
    blockId: "rerun-plan",
    value: { id: "check-plan", status: "fail" },
    status: "pending" as BlockRunStatus,
    isOnPage: true,
  }

  it("shows a block without the prop", () => {
    expect(
      showWhenBlockState({ ...showBase, value: undefined, runs: {}, isOnPage: undefined }),
    ).toEqual({ shown: true, condition: null, error: null })
  })

  it("shows the block only while the named block's latest run ended as the prop says", () => {
    const stateWhen = (status: BlockRunStatus) =>
      showWhenBlockState({ ...showBase, runs: runsOf(run("check-plan", status)) }).shown

    expect(stateWhen("pending")).toBe(false)
    expect(stateWhen("running")).toBe(false)
    expect(stateWhen("success")).toBe(false)
    expect(stateWhen("warn")).toBe(false)
    expect(stateWhen("fail")).toBe(true)
  })

  it("keeps a running block shown", () => {
    const state = showWhenBlockState({
      ...showBase,
      status: "running",
      runs: runsOf(run("check-plan", "success")),
    })

    expect(state.shown).toBe(true)
  })

  it("matches the id the way templates do, hyphens and underscores alike", () => {
    const state = showWhenBlockState({
      ...showBase,
      value: { id: "check_plan", status: ["warn", "fail"] },
      runs: runsOf(run("check-plan", "warn")),
    })

    expect(state).toEqual({
      shown: true,
      condition: { id: "check_plan", statuses: ["warn", "fail"] },
      error: null,
    })
  })

  it("reports an id no block on the page has", () => {
    const state = showWhenBlockState({ ...showBase, runs: {}, isOnPage: false })

    expect(state.shown).toBe(true)
    expect(state.error).toBe(
      'showWhenBlock names "check-plan", but no Check, Command, Finish or Prerequisites block has that id.',
    )
  })

  it("reports a block that has no runs", () => {
    const state = showWhenBlockState({ ...showBase, runs: {}, isOnPage: true })

    expect(state.error).toContain("no Check, Command, Finish or Prerequisites block")
  })

  it("waits for the blocks to register before reporting a missing id", () => {
    const state = showWhenBlockState({ ...showBase, runs: {}, isOnPage: undefined })

    expect(state).toEqual({
      shown: false,
      condition: { id: "check-plan", statuses: ["fail"] },
      error: null,
    })
  })

  it("reports the block naming itself, and a prop that isn't valid", () => {
    expect(
      showWhenBlockState({
        ...showBase,
        value: { id: "rerun-plan", status: "fail" },
        runs: runsOf(run("rerun-plan", "fail")),
      }).error,
    ).toBe("showWhenBlock can't name the block itself.")
    expect(
      showWhenBlockState({ ...showBase, value: { id: "check-plan" }, runs: {} }).error,
    ).toContain("status must be")
  })
})
