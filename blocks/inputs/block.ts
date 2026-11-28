/**
 * Inputs: a form whose fields are a boilerplate config's variables, written
 * in a ```yaml fence inside the block or in the file its `path` names.
 * Other blocks read its values through `inputsId`, or, inside a task, as
 * the task's own form.
 *
 * - Its fields are read once, when the runbook opens, before trust, by the
 *   shared boilerplate reader (`formSpec.ts`), in the form's order. Each
 *   malformed setting is a configuration error naming the field, at its
 *   line, and the block never runs (H2).
 * - `path` names the config itself, or a folder: its `boilerplate.yml`, or
 *   else its `boilerplate.yaml`. The file is the one the engine read and
 *   hashed when the runbook opened, never read again.
 * - `prefilledVariables` sets fields' starting values, over the config's
 *   defaults: what a field starts with and what its Reset puts back. A name
 *   the form lacks is a configuration error.
 * - Until its first Submit its readers get each field's starting value;
 *   from then on, each valid change, live (H1). Inside a task it has no
 *   Submit, so its values are always live. The engine keeps both rules.
 * - It publishes no outputs: its values reach other blocks as values.
 */
import { Effect, Result, Schema } from "effect"
import { defineForm, PropError, RunbookPath } from "@runbooks/blocks-core/contract"
import { FieldValue, type FormSpec } from "@runbooks/blocks-core/form"
import {
  boilerplateFileIn,
  prefilledProblems,
  readBoilerplateFile,
  readBoilerplateForm,
  withPrefilled,
} from "@runbooks/core/domain/boilerplate/formSpec"

const InputsProps = Schema.Struct({
  /** A boilerplate config in the runbook's folder, or the folder that holds one. */
  path: Schema.optionalKey(RunbookPath),
  /** Starting values, by field name, over the config's defaults. */
  prefilledVariables: Schema.optionalKey(Schema.Record(Schema.String, FieldValue)),
  /**
   * The config written inside the block, from its ```yaml fence: only
   * there, as the parser reads it. Each problem the reader finds in it is
   * an error at its own line.
   */
  yaml: Schema.optionalKey(
    Schema.Unknown.check(
      Schema.makeFilter((data) =>
        readBoilerplateForm(data).problems.map(({ path, message }) => ({ path, issue: message })),
      ),
    ),
  ),
}).check(
  Schema.makeFilter((p) => {
    if (p.path !== undefined && p.yaml !== undefined)
      return {
        path: ["path"],
        issue:
          "set `path` or write the variables in a ```yaml code fence inside the block, not both",
      }
    // On the YAML, so YAML that doesn't parse is the one error: the parser says why.
    if (p.path === undefined && p.yaml === undefined)
      return {
        path: ["yaml"],
        issue:
          "write the form's variables in a ```yaml code fence inside the block, or set `path`, a boilerplate.yml or the folder that holds one",
      }
    // A config in a file is read when the runbook opens, so its names are checked then.
    if (p.yaml === undefined) return undefined
    const problems = prefilledProblems(readBoilerplateForm(p.yaml).spec, p.prefilledVariables)
    return problems.map(({ message }) => ({ path: ["prefilledVariables"], issue: message }))
  }),
)
type InputsProps = typeof InputsProps.Type

/** The form a config in a file gives, with its prefilled values, or why there is none. */
function fileForm(
  p: InputsProps & { readonly path: RunbookPath },
  files: ReadonlyMap<string, string>,
): Effect.Effect<FormSpec, PropError> {
  const found = boilerplateFileIn(files, p.path)
  if (found === undefined)
    return Effect.fail(
      new PropError({
        prop: "path",
        message: `There is no boilerplate.yml or boilerplate.yaml in ${p.path}.`,
      }),
    )
  const read = readBoilerplateFile(found.file, found.text)
  // `fields` gives one error: each problem is a sentence of it, with its line.
  if (Result.isFailure(read))
    return Effect.fail(new PropError({ prop: "path", message: read.failure.join(" ") }))
  const problems = prefilledProblems(read.success, p.prefilledVariables)
  if (problems.length > 0)
    return Effect.fail(
      new PropError({
        prop: "prefilledVariables",
        message: `the \`prefilledVariables\` prop of <Inputs>: ${problems.map(({ message }) => message).join("; ")}`,
      }),
    )
  return Effect.succeed(withPrefilled(read.success, p.prefilledVariables))
}

export const inputs = defineForm({
  name: "Inputs",
  since: "0.1.0",
  class: "form",
  props: InputsProps,
  children: { kind: "yaml", prop: "yaml" },
  references: {},
  runbookFiles: (p) => (p.path === undefined ? [] : [p.path]),
  provides: ["values"],
  effects: [],
  outputs: () => ({}),
  fields: (p, files) =>
    p.path !== undefined
      ? fileForm({ ...p, path: p.path }, files)
      : Effect.succeed(withPrefilled(readBoilerplateForm(p.yaml).spec, p.prefilledVariables)),
  plugins: [],
})
