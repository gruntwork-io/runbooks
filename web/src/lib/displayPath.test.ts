import { describe, it, expect } from "vitest"
import { abbreviatePaths } from "./displayPath"

const HOME = "/Users/me"
const SESSION = "/Users/me/Library/Application Support/Runbooks/v0/sessions/dirs/0199a5c2"
const ROOTS = { sessionDir: SESSION, homeDir: HOME }

describe("abbreviatePaths", () => {
  it("shortens a path in the session's directory to session/", () => {
    expect(abbreviatePaths(`${SESSION}/generated/service.yaml`, ROOTS)).toBe(
      "session/generated/service.yaml",
    )
    expect(abbreviatePaths(SESSION, ROOTS)).toBe("session")
    expect(abbreviatePaths(`${SESSION}/`, ROOTS)).toBe("session/")
  })

  it("shortens another path in the home directory to ~/", () => {
    expect(abbreviatePaths(`${HOME}/dev/infrastructure-live`, ROOTS)).toBe(
      "~/dev/infrastructure-live",
    )
    expect(abbreviatePaths(`${HOME}/Library/Application Support/Runbooks`, ROOTS)).toBe(
      "~/Library/Application Support/Runbooks",
    )
  })

  it("leaves a path outside both, and one that only starts with the same letters", () => {
    expect(abbreviatePaths("/opt/repos/infra", ROOTS)).toBe("/opt/repos/infra")
    expect(abbreviatePaths("/Users/meg/dev", ROOTS)).toBe("/Users/meg/dev")
    expect(abbreviatePaths(`${SESSION}-old/x`, ROOTS)).toBe(
      `~/Library/Application Support/Runbooks/v0/sessions/dirs/0199a5c2-old/x`,
    )
    expect(abbreviatePaths(`/mnt${HOME}/dev`, ROOTS)).toBe(`/mnt${HOME}/dev`)
  })

  it("shortens every path in a message", () => {
    expect(
      abbreviatePaths(
        `Successfully deleted 2 file(s) from ${SESSION}/generated, not ${HOME}/x.`,
        ROOTS,
      ),
    ).toBe("Successfully deleted 2 file(s) from session/generated, not ~/x.")
    expect(abbreviatePaths(`cp '${SESSION}/a' "${HOME}/b"`, ROOTS)).toBe(`cp 'session/a' "~/b"`)
  })

  it("takes roots written with a trailing separator, and Windows paths", () => {
    expect(abbreviatePaths(`${HOME}/dev`, { homeDir: `${HOME}/` })).toBe("~/dev")
    expect(
      abbreviatePaths("C:\\Users\\me\\AppData\\Roaming\\Runbooks\\x", { homeDir: "C:\\Users\\me" }),
    ).toBe("~\\AppData\\Roaming\\Runbooks\\x")
  })

  it("shortens nothing against roots it doesn't know, or a filesystem root", () => {
    expect(abbreviatePaths(`${HOME}/dev`, {})).toBe(`${HOME}/dev`)
    expect(abbreviatePaths("/etc/hosts", { homeDir: "/" })).toBe("/etc/hosts")
  })
})
