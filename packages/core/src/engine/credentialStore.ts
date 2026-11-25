/**
 * The credential store: what each credential block's provider last gave
 * from `env`, the only call that returns secret values. One store per
 * session, keyed by block, so a run gets a block's values only by naming
 * that block in `envFrom`, and no session reaches another's. It holds a
 * block's values exactly while the block is Ready (`move` in
 * `./credentials.ts` keeps it so). Every value stays `Redacted`.
 *
 * It is the secret half of what a saved session needs: the event log has
 * every state, identity and expiry and no value. The session saves a Ready
 * block's values, encrypted, through the session store, so its provider
 * can find the login in them again when the session resumes.
 */
import type { BlockId } from "@runbooks/blocks-core/contract"
import type { CredentialEnv } from "../credential/provider.ts"

export interface CredentialStore {
  readonly get: (block: BlockId) => CredentialEnv | undefined
  readonly set: (block: BlockId, env: CredentialEnv) => void
  readonly delete: (block: BlockId) => void
  /** Every Ready block's values. */
  readonly entries: () => ReadonlyArray<readonly [BlockId, CredentialEnv]>
}

/** A store for the credential blocks `blocks`, and no others, so it holds at most one entry each. */
export function makeCredentialStore(blocks: ReadonlyArray<BlockId>): CredentialStore {
  const known = new Set(blocks)
  const held = new Map<BlockId, CredentialEnv>()
  return {
    get: (block) => held.get(block),
    set: (block, env) => {
      // The session makes the store from its own credential blocks.
      if (!known.has(block))
        throw new Error(`${block} is not one of the session's credential blocks.`)
      held.set(block, env)
    },
    delete: (block) => {
      held.delete(block)
    },
    entries: () => Array.from(held),
  }
}
