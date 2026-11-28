/**
 * The registry: one line per block or alias, re-exported under its MDX tag.
 *
 *   export { command as Command } from "./command/block.ts"
 *
 * `import * as registry from "@runbooks/blocks"` is the tag-to-entry map
 * (`@runbooks/blocks-core/registry`).
 */
export { admonition as Admonition } from "./admonition/block.ts"
export { awsAuth as AwsAuth } from "./aws-auth/block.ts"
export { command as Command } from "./command/block.ts"
export { inputs as Inputs } from "./inputs/block.ts"
