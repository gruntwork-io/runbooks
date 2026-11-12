/**
 * The life of a block's Terragrunt run, as one state machine: what each
 * phase holds, which events move it on, and what it means for the inputs as
 * they are now. Pure, so the transitions are tested without the main process.
 */
import type {
  ApplyResult,
  PlanResult,
  ResourceProgress,
  RunEvent,
} from "../../../../../src/domain/terragrunt/run"

export type RunStep = Extract<RunEvent, { kind: "step" }>["step"]

export interface LogLine {
  readonly line: string
  readonly level?: "error" | "warn" | undefined
  /** When the line was written, as an ISO timestamp. */
  readonly at: string
}

export type Progress = Readonly<Record<string, { progress: ResourceProgress; elapsed?: number }>>

/** Which run a phase belongs to: the plan, or the apply of that plan. */
export type RunKind = "plan" | "apply"

/**
 * Where the run is. Every phase after idle carries the inputs it ran with
 * (`inputs`, as a stable key), so a change to them shows the run is stale.
 */
export type RunPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "planning"
      readonly inputs: string
      readonly step?: RunStep | undefined
      readonly stopping?: boolean | undefined
    }
  | { readonly kind: "planned"; readonly inputs: string; readonly plan: PlanResult }
  | {
      readonly kind: "applying"
      readonly inputs: string
      readonly plan: PlanResult
      readonly progress: Progress
      readonly step?: RunStep | undefined
      /** Asked to stop, and still running until Terragrunt exits. */
      readonly stopping?: boolean | undefined
    }
  | {
      readonly kind: "applied"
      readonly inputs: string
      readonly plan: PlanResult
      readonly result: ApplyResult
    }
  /** Stopped on request: a stopped apply may have made some resources. */
  | ({ readonly kind: "stopped" } & Ended)
  | ({ readonly kind: "failed"; readonly error: string } & Ended)

/** Where a plan or apply had got to when it stopped or failed. */
interface Ended {
  readonly during: RunKind
  readonly inputs: string
  /** The step it was on. */
  readonly step?: RunStep | undefined
  /** For an apply: the plan, and how far each resource got. */
  readonly plan?: PlanResult | undefined
  readonly progress?: Progress | undefined
}

export interface RunState {
  readonly phase: RunPhase
  /** Terragrunt's log for the current run. */
  readonly log: readonly LogLine[]
}

export type RunAction =
  | { readonly type: "plan-started"; readonly inputs: string }
  | { readonly type: "planned"; readonly plan: PlanResult }
  | { readonly type: "apply-started" }
  | { readonly type: "applied"; readonly result: ApplyResult }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "stop-requested" }
  | { readonly type: "stopped" }
  | { readonly type: "event"; readonly event: RunEvent; readonly at: string }

export const INITIAL_RUN: RunState = { phase: { kind: "idle" }, log: [] }

/** Whether a plan or apply is going, so nothing else may start. */
export const running = (
  phase: RunPhase,
): phase is Extract<RunPhase, { kind: "planning" | "applying" }> =>
  phase.kind === "planning" || phase.kind === "applying"

/**
 * The next state. An action that doesn't fit the phase, such as an apply
 * finishing when nothing is applying, leaves the state as it is.
 */
export function runReducer(state: RunState, action: RunAction): RunState {
  const { phase } = state
  switch (action.type) {
    case "plan-started":
      if (running(phase)) return state
      return { phase: { kind: "planning", inputs: action.inputs }, log: [] }
    case "planned":
      if (phase.kind !== "planning") return state
      return { ...state, phase: { kind: "planned", inputs: phase.inputs, plan: action.plan } }
    case "apply-started":
      if (phase.kind !== "planned") return state
      return {
        ...state,
        phase: {
          kind: "applying",
          inputs: phase.inputs,
          plan: phase.plan,
          progress: Object.fromEntries(
            phase.plan.resources.map((r) => [r.address, { progress: "waiting" as const }]),
          ),
        },
      }
    case "applied":
      if (phase.kind !== "applying") return state
      return {
        ...state,
        phase: { kind: "applied", inputs: phase.inputs, plan: phase.plan, result: action.result },
      }
    case "stop-requested":
      if (!running(phase)) return state
      return { ...state, phase: { ...phase, stopping: true } }
    case "failed":
    case "stopped": {
      if (!running(phase)) return state
      const during: RunKind = phase.kind === "planning" ? "plan" : "apply"
      const made = {
        ...(phase.step ? { step: phase.step } : {}),
        ...(phase.kind === "applying" ? { plan: phase.plan, progress: phase.progress } : {}),
      }
      return {
        ...state,
        phase:
          action.type === "failed"
            ? { kind: "failed", during, inputs: phase.inputs, error: action.error, ...made }
            : { kind: "stopped", during, inputs: phase.inputs, ...made },
      }
    }
    case "event": {
      const { event } = action
      if (event.kind === "log") {
        return {
          ...state,
          log: [...state.log, { line: event.line, level: event.level, at: action.at }],
        }
      }
      if (!running(phase)) return state
      if (event.kind === "step") return { ...state, phase: { ...phase, step: event.step } }
      if (phase.kind !== "applying") return state
      return {
        ...state,
        phase: {
          ...phase,
          progress: {
            ...phase.progress,
            [event.address]: {
              progress: event.progress,
              ...(event.elapsedSeconds !== undefined ? { elapsed: event.elapsedSeconds } : {}),
            },
          },
        },
      }
    }
  }
}

/**
 * What the run means for the inputs as they are now:
 * - `none`: nothing planned for them yet, or the last plan didn't finish;
 * - `running`: a plan or apply is going;
 * - `ready`: planned, with changes to apply;
 * - `current`: applied, or planned with nothing to change, so the
 *   infrastructure matches them;
 * - `stale`: the last plan or apply was for other inputs, so it needs a new plan;
 * - `failed`: the apply failed or was stopped partway, so it needs a new plan.
 */
export type RunStatus = "none" | "running" | "ready" | "current" | "stale" | "failed"

export function runStatus(phase: RunPhase, inputs: string): RunStatus {
  if (running(phase)) return "running"
  if (phase.kind === "idle") return "none"
  if (phase.inputs !== inputs)
    return phase.kind === "planned" || phase.kind === "applied" ? "stale" : "none"
  switch (phase.kind) {
    case "planned":
      return phase.plan.resources.length === 0 ? "current" : "ready"
    case "applied":
      return "current"
    case "stopped":
    case "failed":
      return phase.during === "plan" ? "none" : "failed"
  }
}
