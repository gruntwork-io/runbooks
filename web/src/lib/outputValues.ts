/**
 * Block output values for the renderer.
 *
 * The implementation lives in src/domain/exec/outputValues.ts so the main
 * process, the `runbooks test` CLI and this UI carry a sensitive output the
 * same way: as an Effect `Redacted` that prints `<redacted>`, read only
 * through `revealOutput`.
 */
export {
  sensitiveOutput,
  isSensitiveOutput,
  revealOutput,
  maskOutput,
  revealOutputs,
  maskOutputs,
  decodeOutputs,
  type OutputValue,
  type OutputValues,
  type EncodedOutputValue,
  type EncodedOutputValues,
} from '../../../src/domain/exec/outputValues'
