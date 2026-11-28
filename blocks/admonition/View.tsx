/**
 * Admonition's view: the callout box in its type's colors, with its
 * heading, its description, the markdown written inside it, and the
 * buttons that dismiss it. The frame draws nothing around it
 * (`drawsItself`), so closing or confirming takes all of it off the page,
 * until the runbook is drawn again.
 */
import { type ReactNode, useState } from "react"
import type { AdmonitionProps, AdmonitionType } from "./block.ts"

/**
 * Each type's name, its box's colors and its button's. A warning's button
 * is red, as a danger's is: white text on amber is hard to read.
 */
const LOOK: {
  readonly [T in AdmonitionType]: {
    readonly name: string
    readonly box: string
    readonly button: string
  }
} = {
  note: {
    name: "Note",
    box: "border-zinc-300 bg-zinc-50 text-zinc-900",
    button: "bg-zinc-800 text-white hover:bg-zinc-700",
  },
  info: {
    name: "Info",
    box: "border-sky-300 bg-sky-50 text-sky-950",
    button: "bg-sky-700 text-white hover:bg-sky-800",
  },
  warning: {
    name: "Warning",
    box: "border-amber-300 bg-amber-50 text-amber-950",
    button: "bg-red-700 text-white hover:bg-red-800",
  },
  danger: {
    name: "Danger",
    box: "border-red-300 bg-red-50 text-red-950",
    button: "bg-red-700 text-white hover:bg-red-800",
  },
}

export function AdmonitionView({
  props,
  children,
}: {
  readonly props: AdmonitionProps
  /** The markdown written inside it, rendered. */
  readonly children?: ReactNode
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  const look = LOOK[props.type]
  const heading = props.title === undefined || props.title === "" ? look.name : props.title
  return (
    <div
      role="note"
      aria-label={look.name}
      className={`mb-4 flex items-start gap-2 rounded-md border p-3 text-sm ${look.box}`}
    >
      {/* A long path or URL, one long word, wraps inside the box. */}
      <div className="min-w-0 flex-1 break-words">
        <p className="mb-2 font-semibold">{heading}</p>
        {props.description === undefined ? null : <p>{props.description}</p>}
        {children}
        {props.confirmationText === undefined ? null : (
          <button
            type="button"
            className={`mt-3 cursor-pointer rounded-md px-4 py-2 font-medium ${look.button}`}
            onClick={() => setDismissed(true)}
          >
            {props.confirmationText}
          </button>
        )}
      </div>
      {props.closable === true ? (
        <button
          type="button"
          aria-label="Close"
          className="cursor-pointer leading-none opacity-70 hover:opacity-100"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

/** This block's line in the view map (`blocks/views.ts`), under its tag. */
export const view = { Admonition: AdmonitionView }
