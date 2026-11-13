import { createContext, useContext } from "react"
import { useApi } from "@/contexts/ApiContext"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { useAllOutputs } from "@/contexts/useRunbook"
import { normalizeBlockId } from "@/lib/utils"
import { revealOutputs } from "../../../../../../src/domain/exec/outputValues"
import {
  inputsRead,
  readsQuery,
  runLookup,
  type LookupResult,
  type RunContext,
} from "../../../../../../src/domain/lookups/run"
import type { AuthKind, Definitions, Use } from "../../../../../../src/domain/lookups/types"
import { usedGroups } from "../../../../../../src/domain/lookups/validate"
import { authFacts, signedIn } from "../authFacts"

/** Runs a form's lookups, through the auth blocks its `auth` prop binds their groups to. */
export interface LookupEngine {
  run: (use: Use, query: string) => Promise<LookupResult>
  /** Whether the use's lookup asks the API with what's typed, rather than the form filtering its rows. */
  readsQuery: (use: Use) => boolean
  /**
   * Changes when anything the use's answer depends on changes: a sign-in to a
   * bound block, or an input it reads.
   */
  keyOf: (use: Use) => string
}

export const LookupEngineContext = createContext<LookupEngine | undefined>(undefined)

/** The engine for the form's lookups, if it has a provider. */
export function useLookupEngineContext(): LookupEngine | undefined {
  return useContext(LookupEngineContext)
}

/**
 * The engine for a form whose inputs hold `inputs`, binding each lookup group
 * to an auth block by `binding`, such as `{ google: "workspace" }`.
 */
export function useLookupEngine(
  definitions: Definitions,
  binding: Readonly<Record<string, string>>,
  inputs: Readonly<Record<string, unknown>>,
): LookupEngine {
  const api = useApi()
  const outputs = useAllOutputs()
  const { asWritten } = usePageBlocks()
  const boundValues = (group: string): Record<string, string> | undefined => {
    const blockId = binding[group]
    const values = blockId ? outputs[normalizeBlockId(blockId)]?.values : undefined
    return values ? revealOutputs(values) : undefined
  }

  const send: RunContext["send"] = async (request, group, kind: AuthKind) => {
    const blockId = binding[group]
    if (!blockId) throw new Error(`The ${group} lookups aren't bound to an auth block.`)
    const values = boundValues(group)
    if (!values || !signedIn(kind, values)) {
      throw new Error(`Sign in with the ${asWritten(blockId)} block above for suggestions here.`)
    }
    if (kind === "GoogleAuth") {
      return api.invoke("google:send", { blockId: asWritten(blockId), request })
    }
    return api.invoke("aws:send", {
      credentials: {
        accessKeyId: values.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: values.AWS_SECRET_ACCESS_KEY ?? "",
        ...(values.AWS_SESSION_TOKEN ? { sessionToken: values.AWS_SESSION_TOKEN } : {}),
      },
      request,
    })
  }

  const context: RunContext = {
    definitions,
    inputs,
    auth: (group) => {
      const kind = definitions.groups[group]?.auth
      const values = boundValues(group)
      return kind && values ? authFacts(kind, values) : {}
    },
    send,
  }

  // Who each bound block is signed in as, and when, so answers are asked for again after a sign-in.
  const signIns = JSON.stringify(
    Object.entries(binding).map(([group, blockId]) => [
      group,
      outputs[normalizeBlockId(blockId)]?.timestamp,
    ]),
  )
  // A new engine each render, so a lookup reads the newest values; users key
  // their requests by keyOf, not by the engine.
  return {
    run: (use, query) => runLookup(context, use, query),
    readsQuery: (use) => {
      const def = definitions.lookups[use.from]
      return def ? readsQuery(def) : false
    },
    keyOf: (use) => {
      const groups = usedGroups(definitions, [use], [])
      const read = inputsRead(definitions, use).map((name) => inputs[name])
      return JSON.stringify([use, read, signIns, groups])
    },
  }
}
