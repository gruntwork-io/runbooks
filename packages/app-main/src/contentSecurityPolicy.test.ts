import { describe, expect, it } from "bun:test"
import { contentSecurityPolicy, DEV_SERVER_NONCE } from "./contentSecurityPolicy.ts"

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...sources] = directive.split(" ")
      return [name, sources]
    }),
  )

describe("the window's CSP", () => {
  it("lets a build's page run its scripts, load its stylesheet and a runbook's images and media, and nothing else", () => {
    expect(contentSecurityPolicy(undefined)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src runbook-asset:; media-src runbook-asset:; base-uri 'none'; form-action 'none'",
    )
  })

  it("is the build's on the dev server, plus Vite's tagged scripts and styles and its socket", () => {
    const build = directives(contentSecurityPolicy(undefined))
    const dev = directives(contentSecurityPolicy(new URL("http://localhost:5173/")))
    const nonce = `'nonce-${DEV_SERVER_NONCE}'`
    expect(dev).toEqual(
      new Map([
        ...build,
        ["script-src", ["'self'", nonce]],
        ["style-src", ["'self'", nonce]],
        ["connect-src", ["'self'", "ws://localhost:5173"]],
      ]),
    )
  })

  it("never allows inline or evaluated code without a nonce", () => {
    for (const devServer of [undefined, new URL("http://localhost:5173/")]) {
      const policy = contentSecurityPolicy(devServer)
      expect(policy).not.toContain("unsafe-")
      expect(policy).not.toContain("*")
    }
  })
})
