/**
 * What `terragrunt render --format=json` says about a unit, for a
 * <TerragruntApply> block's preflight: the module the unit uses, so the block
 * can run that module's checks, and the unit's inputs, which those checks
 * read as `.inputs`.
 */

export interface RenderedUnit {
  /** The unit's `terraform.source`, as Terragrunt resolved it, when it sets one. */
  readonly source?: string
  readonly inputs: Readonly<Record<string, unknown>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads the JSON Terragrunt rendered. A block HCL allows once may come as a list of one. */
export function renderedUnit(json: unknown): RenderedUnit {
  if (!isRecord(json)) return { inputs: {} }
  const single = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const terraform = single(json.terraform)
  const source = isRecord(terraform) ? terraform.source : undefined
  const inputs = isRecord(json.inputs) ? json.inputs : {}
  return { ...(typeof source === "string" && source ? { source } : {}), inputs }
}
