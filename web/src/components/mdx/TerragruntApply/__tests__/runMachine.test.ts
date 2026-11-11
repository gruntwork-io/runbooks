import { describe, expect, it } from "vitest"
import type { ApplyResult, PlanResult } from "../../../../../../src/domain/terragrunt/run"
import { inputsKey } from "../../../../../../src/domain/tf-module/inputsKey"
import { INITIAL_RUN, runReducer, runStatus, type RunAction, type RunState } from "../runMachine"

const PLAN: PlanResult = {
  resources: [
    { address: "a.b", type: "a", name: "b", action: "create", properties: {} },
    { address: "a.c", type: "a", name: "c", action: "create", properties: {} },
  ],
}
const NO_CHANGES: PlanResult = { resources: [] }
const RESULT: ApplyResult = { resources: [], outputs: [] }
const A = inputsKey({ id: "platform" })
const B = inputsKey({ id: "security" })
const AT = "2026-11-10T12:00:00.000Z"

const run = (...actions: RunAction[]): RunState => actions.reduce(runReducer, INITIAL_RUN)

describe("runReducer", () => {
  it("goes from a plan to an apply, keeping the inputs it ran with", () => {
    const state = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
      { type: "applied", result: RESULT },
    )
    expect(state.phase).toMatchObject({ kind: "applied", inputs: A, plan: PLAN, result: RESULT })
  })

  it("marks each resource waiting when an apply starts, then follows its progress", () => {
    const state = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
      {
        type: "event",
        event: { kind: "resource", address: "a.b", progress: "done", elapsedSeconds: 2 },
        at: AT,
      },
    )
    expect(state.phase).toMatchObject({
      kind: "applying",
      progress: { "a.b": { progress: "done", elapsed: 2 }, "a.c": { progress: "waiting" } },
    })
  })

  it("records a stop apart from a failure, with where it got to", () => {
    const planning = run(
      { type: "plan-started", inputs: A },
      { type: "event", event: { kind: "step", step: "plan" }, at: AT },
    )
    expect(runReducer(planning, { type: "stopped" }).phase).toEqual({
      kind: "stopped",
      during: "plan",
      inputs: A,
      step: "plan",
    })
    const applying = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
    )
    expect(runReducer(applying, { type: "failed", error: "403" }).phase).toMatchObject({
      kind: "failed",
      during: "apply",
      error: "403",
      plan: PLAN,
    })
  })

  it("ignores an action that doesn't fit the phase", () => {
    expect(run({ type: "apply-started" })).toBe(INITIAL_RUN)
    const planning = run({ type: "plan-started", inputs: A })
    expect(runReducer(planning, { type: "plan-started", inputs: B })).toBe(planning)
    expect(runReducer(planning, { type: "applied", result: RESULT })).toBe(planning)
  })

  it("starts a new plan with an empty log", () => {
    const logged = run(
      { type: "plan-started", inputs: A },
      { type: "event", event: { kind: "log", line: "init" }, at: AT },
      { type: "planned", plan: PLAN },
    )
    expect(logged.log).toEqual([{ line: "init", level: undefined, at: AT }])
    expect(runReducer(logged, { type: "plan-started", inputs: A }).log).toEqual([])
  })
})

describe("runStatus", () => {
  it("is ready for a plan with changes, and current once applied", () => {
    const planned = run({ type: "plan-started", inputs: A }, { type: "planned", plan: PLAN })
    expect(runStatus(planned.phase, A)).toBe("ready")
    const applied = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
      { type: "applied", result: RESULT },
    )
    expect(runStatus(applied.phase, A)).toBe("current")
  })

  it("counts a plan with nothing to change as current", () => {
    const planned = run({ type: "plan-started", inputs: A }, { type: "planned", plan: NO_CHANGES })
    expect(runStatus(planned.phase, A)).toBe("current")
  })

  it("is stale once the inputs change after a plan or an apply", () => {
    const applied = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
      { type: "applied", result: RESULT },
    )
    expect(runStatus(applied.phase, B)).toBe("stale")
  })

  it("needs a plan after a stopped plan, and flags an apply that ended partway", () => {
    const stoppedPlan = run({ type: "plan-started", inputs: A }, { type: "stopped" })
    expect(runStatus(stoppedPlan.phase, A)).toBe("none")
    const failedApply = run(
      { type: "plan-started", inputs: A },
      { type: "planned", plan: PLAN },
      { type: "apply-started" },
      { type: "failed", error: "x" },
    )
    expect(runStatus(failedApply.phase, A)).toBe("failed")
  })
})
