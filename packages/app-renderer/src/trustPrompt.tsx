/**
 * The trust prompt. While the session is untrusted it says what trusting it
 * allows: each block that declares an effect, each effect in plain words.
 * Its button asks the engine to trust the session (`Following.trust`), and
 * it goes once the session's events say the session is trusted. Its
 * heading, first line and button are the old app's banner's.
 *
 * It shows nothing:
 *
 * - before the window has read the session's trust, and once it is trusted;
 * - in instruction mode, where nothing runs: trusting would let the engine
 *   detect credentials, which runs their providers;
 * - once the window stopped following the session, since a trust given then
 *   would never show;
 * - for a runbook with no block that waits for trust, as one of display
 *   blocks only.
 *
 * Once the engine said the runbook changed since the window showed it, the
 * prompt says so and lists what the runbook holds now in place of the
 * page's blocks, and its button trusts that.
 */
import { Effect } from "effect"
import { useContext } from "react"
import type { DocumentBlock } from "@runbooks/core/protocol"
import {
  FollowingContext,
  useEnded,
  useInstructionMode,
  useTrust,
  useTrusting,
} from "./following.ts"

type Configured = Extract<DocumentBlock, { readonly _tag: "Configured" }>
type MachineEffect = Configured["effects"][number]

/** What `effect` lets a block do, after "may". */
function allows(effect: MachineEffect): string {
  switch (effect) {
    case "process":
      return "run commands and scripts on this computer"
    case "files":
      return "create and change files"
    case "repository":
      return "clone and change git repositories"
    case "network":
      return "connect over the network"
    case "push":
      return "push changes to remote repositories"
    case "browser":
      return "open your web browser"
    default: {
      const unhandled: never = effect
      throw new Error(`The trust prompt has no words for the effect ${String(unhandled)}.`)
    }
  }
}

/** Whether a block of `kind` waits for trust: every class with a lifecycle does. */
function waitsForTrust(kind: DocumentBlock["class"]): boolean {
  switch (kind) {
    case "form":
    case "task":
    case "credential":
      return true
    case "display":
      return false
    default: {
      const unhandled: never = kind
      throw new Error(`The trust prompt has no reading of the class ${String(unhandled)}.`)
    }
  }
}

/** `phrases` as one: "a", "a and b", "a, b and c". */
function joined(phrases: ReadonlyArray<string>): string {
  const last = phrases.at(-1) ?? ""
  return phrases.length < 2 ? last : `${phrases.slice(0, -1).join(", ")} and ${last}`
}

export function TrustPrompt({ blocks }: { readonly blocks: ReadonlyArray<DocumentBlock> }) {
  const trust = useTrust()
  const { changed, failed } = useTrusting()
  const instructionMode = useInstructionMode()
  const ended = useEnded()
  const following = useContext(FollowingContext)
  if (trust === undefined || trust.trusted || instructionMode || ended !== undefined) return null
  const configured = (changed?.blocks ?? blocks).filter(
    (block): block is Configured => block._tag === "Configured",
  )
  if (!configured.some((block) => waitsForTrust(block.class))) return null
  const declaring = configured.filter((block) => block.effects.length > 0)
  return (
    <section className="trust" aria-label="Trust this runbook">
      <h2>Make sure you trust this runbook</h2>
      {changed === undefined ? null : (
        <p className="trust-changed">
          This runbook changed since the window showed it, so nothing was trusted. This is what it
          holds now.
        </p>
      )}
      <p>
        Runbooks can execute arbitrary code directly in your environment. Until you trust this one,
        nothing in it runs.
        {declaring.length === 0
          ? " No block in it declares that it does anything to this computer or over the network."
          : " Once you do:"}
      </p>
      {declaring.length === 0 ? null : (
        <ul aria-label="What trusting it allows">
          {declaring.map((block) => (
            <li key={block.index}>
              <code>{`<${block.tag}>`}</code>
              {block.id === undefined ? "" : ` ${block.id}`}
              {block.title === undefined ? "" : ` (${block.title})`}
              {` may ${joined(block.effects.map(allows))}.`}
            </li>
          ))}
        </ul>
      )}
      <p>Trust it only if you trust its author and have reviewed its code.</p>
      {failed === undefined ? null : <p className="trust-failed">{failed}</p>}
      <button type="button" onClick={() => Effect.runFork(following.trust())}>
        I trust this runbook
      </button>
    </section>
  )
}
