import { describe, it, expect } from "bun:test"
import type { Session } from "electron"
import { installPermissionHandlers } from "./permissions.ts"

type RequestHandler = Parameters<Session["setPermissionRequestHandler"]>[0]
type CheckHandler = Parameters<Session["setPermissionCheckHandler"]>[0]

/** Install the handlers on a stand-in session and return them. */
function handlers(): { request: NonNullable<RequestHandler>; check: NonNullable<CheckHandler> } {
  let request: RequestHandler = null
  let check: CheckHandler = null
  installPermissionHandlers({
    setPermissionRequestHandler: (h: RequestHandler) => {
      request = h
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      check = h
    },
  } as unknown as Session)
  return { request: request!, check: check! }
}

/** The answer the request handler gives. */
function requestAnswer(permission: string, isMainFrame: boolean): boolean {
  let answer: boolean | undefined
  handlers().request(
    {} as Electron.WebContents,
    permission as Parameters<NonNullable<RequestHandler>>[1],
    (granted) => {
      answer = granted
    },
    { isMainFrame, requestingUrl: "file:///app/index.html" } as Electron.PermissionRequest,
  )
  return answer!
}

function checkAnswer(permission: string, isMainFrame: boolean): boolean {
  return handlers().check(
    null,
    permission as Parameters<NonNullable<CheckHandler>>[1],
    "file:///",
    { isMainFrame } as Electron.PermissionCheckHandlerHandlerDetails,
  )
}

describe("installPermissionHandlers", () => {
  it("lets the app's main frame write to the clipboard", () => {
    expect(requestAnswer("clipboard-sanitized-write", true)).toBe(true)
    expect(checkAnswer("clipboard-sanitized-write", true)).toBe(true)
  })

  it.each(["media", "geolocation", "notifications", "clipboard-read", "openExternal"])(
    "denies %s to the app's main frame",
    (permission) => {
      expect(requestAnswer(permission, true)).toBe(false)
      expect(checkAnswer(permission, true)).toBe(false)
    },
  )

  it.each(["media", "clipboard-sanitized-write", "geolocation"])("denies %s to a frame", (permission) => {
    expect(requestAnswer(permission, false)).toBe(false)
    expect(checkAnswer(permission, false)).toBe(false)
  })
})
