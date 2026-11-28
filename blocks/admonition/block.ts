/**
 * Admonition: a callout box for a note, info, a warning or a danger, which
 * its view draws (`View.tsx`). A display block: it gives the runbook
 * nothing, is never a progress step, and the session saves nothing of it.
 *
 * - `type` is one of the four, and every Admonition sets it.
 * - Its `title` and `description` are its own props as well as the shared
 *   ones, since its view draws all of it (the frame's `drawsItself`).
 * - Its text shows as written: no `{{ }}` is filled in. The parser ignores
 *   an `inputsId` on it, and warns of each `{{ .inputs }}` and
 *   `{{ .outputs }}` in its props: the contract gives a display block no
 *   values to read.
 * - `closable` adds a close button, and `confirmationText` a button that
 *   dismisses it. Either holds until the runbook is drawn again.
 * - `allowPermanentHide` adds "Don't show me this again" under the
 *   confirmation, which hides it for good under `storageKey`, in its own
 *   runbook only (the view's `hidden`). The two go together, with
 *   `confirmationText`: each without the others would do nothing, so it is
 *   a configuration error.
 */
import { Schema } from "effect"
import { defineDisplay } from "@runbooks/blocks-core/contract"
import { HiddenKey } from "@runbooks/core/protocol"

/** The kinds of callout, each drawn in its own colors. */
export const AdmonitionType = Schema.Literals(["note", "info", "warning", "danger"])
export type AdmonitionType = typeof AdmonitionType.Type

const AdmonitionProps = Schema.Struct({
  type: AdmonitionType,
  /** The callout's heading. Absent or empty: the type's name, as "Warning". */
  title: Schema.optionalKey(Schema.String),
  /** Its message, shown above the markdown written inside it. */
  description: Schema.optionalKey(Schema.String),
  closable: Schema.optionalKey(Schema.Boolean),
  /** The label of a button that dismisses it. */
  confirmationText: Schema.optionalKey(Schema.NonEmptyString),
  allowPermanentHide: Schema.optionalKey(Schema.Boolean),
  /** The name its hide is kept under, within its runbook. */
  storageKey: Schema.optionalKey(HiddenKey),
}).check(
  Schema.makeFilter((p) => {
    const issues: Array<{ readonly path: ReadonlyArray<string>; readonly issue: string }> = []
    if (p.allowPermanentHide === true) {
      if (p.confirmationText === undefined)
        issues.push({
          path: ["allowPermanentHide"],
          issue:
            'it needs `confirmationText`: its "Don\'t show me this again" box is under that button',
        })
      if (p.storageKey === undefined)
        issues.push({
          path: ["allowPermanentHide"],
          issue:
            'it needs `storageKey`, the name the hide is kept under, such as storageKey="welcome"',
        })
    } else if (p.storageKey !== undefined)
      issues.push({
        path: ["storageKey"],
        issue: "it names a hide, so it does nothing without allowPermanentHide={true}",
      })
    return issues
  }),
)
export type AdmonitionProps = typeof AdmonitionProps.Type

export const admonition = defineDisplay({
  name: "Admonition",
  since: "0.1.0",
  class: "display",
  props: AdmonitionProps,
  children: { kind: "markdown" },
  references: {},
  runbookFiles: () => [],
  provides: [],
  effects: [],
})
