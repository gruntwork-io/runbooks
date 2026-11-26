import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { parseBoilerplateConfig } from "./config.ts"

describe("parseBoilerplateConfig", () => {
  it("says where boilerplate.yml isn't valid YAML, and quotes none of it", () => {
    const secret = "fake-secret-yaml-e83f"
    const yaml = `variables:\n  - name: token\n    default: ${secret}\n    default: again\n`
    const error = Effect.runSync(Effect.flip(parseBoilerplateConfig(yaml)))
    expect(error.message).toBe(
      "boilerplate.yml isn't valid YAML at line 4, column 5: a key appears twice in one map.",
    )
    expect(error.message).not.toContain(secret)
    expect(error).not.toHaveProperty("cause")
  })
})
