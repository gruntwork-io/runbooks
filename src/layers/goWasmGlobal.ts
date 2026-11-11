/**
 * Serializes loading Go WebAssembly runtimes in this process.
 *
 * Each Go program compiled to WebAssembly ships a `wasm_exec.js` that sets
 * `globalThis.Go`, and its loader reads that global back after awaiting file
 * reads. Two loads that overlap can each construct the other's `Go`, which
 * starts a program on the wrong runtime. A runtime that has started no longer
 * reads the global, so a load only has to finish before the next one begins.
 */

let chain: Promise<unknown> = Promise.resolve()

/** Runs `load` once every earlier load has settled, and before any later one starts. */
export function loadGoWasm<T>(load: () => Promise<T>): Promise<T> {
  const next = chain.then(load, load)
  chain = next.catch(() => undefined)
  return next
}
