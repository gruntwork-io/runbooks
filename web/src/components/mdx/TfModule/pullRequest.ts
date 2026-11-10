import type { TfModuleSpec } from "../../../../../src/domain/tf-module/types"
import { renderRowTemplate } from "../../../../../src/domain/tf-module/rowTemplate"

/** A value as a pull request's description shows it. */
function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueText).join(", ")
  if (value === null || value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** The pull request's title: runbooks.yml's template, or the block's title. */
export function draftTitle(spec: TfModuleSpec, values: Record<string, unknown>): string {
  const template = spec.pullRequest?.title
  return template ? renderRowTemplate(template, values).trim() : spec.title
}

/**
 * The pull request's description: runbooks.yml's template, or a table of the
 * inputs that have a value, with sensitive ones left out.
 */
export function draftBody(spec: TfModuleSpec, values: Record<string, unknown>): string {
  const template = spec.pullRequest?.description
  if (template) return renderRowTemplate(template, values).trim()
  const rows = spec.variables
    .filter((v) => !v.sensitive && valueText(values[v.name]) !== "")
    .map((v) => `| ${v.label} | \`${valueText(values[v.name]).replace(/\|/g, "\\|")}\` |`)
  return [
    `Adds the code for **${spec.title}**, opened from a runbook.`,
    "",
    "| Input | Value |",
    "| --- | --- |",
    ...rows,
  ].join("\n")
}

/** A branch name from a title: lowercase words joined by dashes, under `runbooks/`. */
export function draftBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return `runbooks/${slug || "change"}`
}

/** Where the unit goes in the repository: the block's `path`, a template over its inputs, or its id. */
export function unitPath(
  template: string | undefined,
  blockId: string,
  values: Record<string, unknown>,
): string {
  return template ? renderRowTemplate(template, values).trim() : blockId
}
