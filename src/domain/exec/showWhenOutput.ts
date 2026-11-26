/**
 * The <ShowWhen> block: content that shows only while another block's output
 * has a given value.
 *
 *   <ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">
 *   ...
 *   </ShowWhen>
 *
 * `output` names a block and one of its outputs, as `{{ .outputs.<block>.<name> }}`
 * does. The block takes one of `equals`, `notEquals` or `in`. Until the output
 * exists, `whenUnknown` decides: "show" (the default) or "hide".
 *
 * Both the app (web/) and the `runbooks test` CLI use this module, so they
 * agree on when the content shows. Imports nothing, so the renderer can bundle it.
 */

/** What the content does while the output it reads doesn't exist. */
const WHEN_UNKNOWN = ["show", "hide"] as const

type WhenUnknown = (typeof WHEN_UNKNOWN)[number]

/** A <ShowWhen> block's condition. */
export interface ShowWhenOutput {
  /** The id of the block whose output the condition reads, as written. */
  readonly blockId: string
  /** The output's name. */
  readonly output: string
  /** True for notEquals: the content shows while the output is none of `values`. */
  readonly negate: boolean
  /** The values the condition compares the output with. */
  readonly values: readonly string[]
  readonly whenUnknown: WhenUnknown
}

export type ParsedShowWhenOutput =
  | { readonly ok: true; readonly condition: ShowWhenOutput }
  | { readonly ok: false; readonly error: string }

const EXAMPLE = '<ShowWhen output="git_auth.GIT_PROVIDER" equals="gitlab">'

/** The props of <ShowWhen> that decide when it shows. */
export interface ShowWhenOutputProps {
  readonly output?: unknown
  readonly equals?: unknown
  readonly notEquals?: unknown
  readonly in?: unknown
  readonly whenUnknown?: unknown
}

/** Check a <ShowWhen> block's props. */
export function parseShowWhenOutput(props: ShowWhenOutputProps): ParsedShowWhenOutput {
  const output = props.output
  if (typeof output !== "string" || output.trim() === "") {
    return {
      ok: false,
      error: `<ShowWhen> needs an output prop that names a block and one of its outputs, such as ${EXAMPLE}.`,
    }
  }
  const dot = output.indexOf(".")
  const blockId = dot === -1 ? "" : output.slice(0, dot).trim()
  const name = dot === -1 ? "" : output.slice(dot + 1).trim()
  if (!blockId || !name || name.includes(".")) {
    return {
      ok: false,
      error: `<ShowWhen>'s output prop "${output}" must be a block ID and an output name, joined by a dot, such as "git_auth.GIT_PROVIDER".`,
    }
  }

  const tests = (["equals", "notEquals", "in"] as const).filter((key) => props[key] !== undefined)
  if (tests.length !== 1) {
    return {
      ok: false,
      error: `<ShowWhen> takes exactly one of equals, notEquals or in${tests.length > 1 ? `, not ${tests.join(" and ")}` : ""}.`,
    }
  }
  const test = tests[0]!
  const value = props[test]
  let values: readonly string[]
  if (test === "in") {
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
      return {
        ok: false,
        error: `<ShowWhen>'s in prop must be a list of text values, such as in={["github", "gitlab"]}.`,
      }
    }
    values = value as string[]
  } else {
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `<ShowWhen>'s ${test} prop must be text, such as ${test}="gitlab".`,
      }
    }
    values = [value]
  }

  const whenUnknown = props.whenUnknown ?? "show"
  if (!(WHEN_UNKNOWN as readonly unknown[]).includes(whenUnknown)) {
    return {
      ok: false,
      error: `<ShowWhen>'s whenUnknown prop must be "show" or "hide".`,
    }
  }

  return {
    ok: true,
    condition: {
      blockId,
      output: name,
      negate: test === "notEquals",
      values,
      whenUnknown: whenUnknown as WhenUnknown,
    },
  }
}

/**
 * Whether the content shows, given the output's value: undefined while the
 * block it names hasn't published that output.
 */
export function showWhenOutputHolds(condition: ShowWhenOutput, value: string | undefined): boolean {
  if (value === undefined) return condition.whenUnknown === "show"
  return condition.values.includes(value) !== condition.negate
}

/** The condition as a sentence fragment, such as `git_auth.GIT_PROVIDER is "gitlab"`. */
export function describeShowWhenOutput(condition: ShowWhenOutput): string {
  const quoted = condition.values.map((v) => `"${v}"`)
  const list =
    quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}` : quoted[0]
  return `${condition.blockId}.${condition.output} is ${condition.negate ? "not " : ""}${list}`
}
