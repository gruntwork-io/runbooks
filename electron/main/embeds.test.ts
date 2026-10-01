import { describe, it, expect } from "bun:test"
import type { Session, WebContents, WebPreferences } from "electron"
import {
  LOCAL_EMBED_PARTITION,
  WEB_EMBED_PARTITION,
  embedPartitionFor,
  hardenEmbedGuest,
  installEmbedSession,
  prepareWebviewAttach,
} from "./embeds.ts"

const HOST = "rabc"

describe("embedPartitionFor", () => {
  it.each([
    ["the open runbook's asset page", `runbook-asset://${HOST}/site/index.html`, LOCAL_EMBED_PARTITION],
    ["an https page", "https://example.com/dashboard", WEB_EMBED_PARTITION],
    ["plain http on localhost", "http://localhost:3000/", WEB_EMBED_PARTITION],
    ["plain http on 127.0.0.1", "http://127.0.0.1:8080/", WEB_EMBED_PARTITION],
    ["another runbook's asset page", "runbook-asset://rother/site/index.html", null],
    ["plain http off the machine", "http://example.com/", null],
    ["a host that only starts with localhost", "http://localhost.evil.example/", null],
    ["a file: URL", "file:///etc/hosts", null],
    ["a data: URL", "data:text/html,hi", null],
    ["not a URL", "./assets/site/index.html", null],
  ])("%s", (_name, url, partition) => {
    expect(embedPartitionFor(url, HOST)).toBe(partition)
  })
})

describe("prepareWebviewAttach", () => {
  it("picks the session from src and overrides what the tag asked for", () => {
    const prefs: WebPreferences = {
      partition: "persist:asked",
      preload: "/tmp/preload.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      enableBlinkFeatures: "SomeFeature",
      webviewTag: true,
    }
    const params: Record<string, string> = { src: "https://example.com/", partition: "persist:asked" }

    expect(prepareWebviewAttach(prefs, params, HOST)).toBe(true)

    expect(prefs.preload).toBeUndefined()
    expect(prefs).toMatchObject({
      partition: WEB_EMBED_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      enableBlinkFeatures: "",
      webviewTag: false,
      disableDialogs: true,
    })
    expect(params.partition).toBe(WEB_EMBED_PARTITION)
  })

  it("puts the open runbook's asset pages in the local session", () => {
    const prefs: WebPreferences = {}
    expect(prepareWebviewAttach(prefs, { src: `runbook-asset://${HOST}/index.html` }, HOST)).toBe(true)
    expect(prefs.partition).toBe(LOCAL_EMBED_PARTITION)
  })

  it.each(["file:///etc/hosts", "runbook-asset://rother/index.html", "http://192.168.1.1/", ""])(
    "refuses %p",
    (src) => {
      expect(prepareWebviewAttach({}, { src }, HOST)).toBe(false)
    },
  )
})

/** A stand-in with `on`, recording each listener by event name. */
function emitter<T extends object>(extra: T = {} as T) {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  return {
    listeners,
    target: { ...extra, on: (name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener) },
  }
}

/** Emit `name` with a preventable event carrying `fields`; returns whether it was prevented. */
function emit(listeners: Map<string, (...args: never[]) => unknown>, name: string, fields = {}, ...args: unknown[]) {
  let prevented = false
  const event = { ...fields, preventDefault: () => (prevented = true) }
  ;(listeners.get(name) as (...a: unknown[]) => unknown)(event, ...args)
  return prevented
}

describe("installEmbedSession", () => {
  it("denies every permission and device, and cancels downloads", () => {
    const handlers: Record<string, (...args: never[]) => unknown> = {}
    const { listeners, target } = emitter({
      setPermissionRequestHandler: (h: never) => (handlers.request = h),
      setPermissionCheckHandler: (h: never) => (handlers.check = h),
      setDevicePermissionHandler: (h: never) => (handlers.device = h),
    })
    installEmbedSession(target as unknown as Session)

    let granted: boolean | undefined
    ;(handlers.request as (...a: unknown[]) => void)({}, "media", (g: boolean) => (granted = g), {})
    expect(granted).toBe(false)
    expect((handlers.check as (...a: unknown[]) => boolean)({}, "clipboard-sanitized-write", "", {})).toBe(false)
    expect((handlers.device as (...a: unknown[]) => boolean)({ deviceType: "usb" })).toBe(false)
    expect(emit(listeners, "will-download")).toBe(true)
  })
})

describe("hardenEmbedGuest", () => {
  function guest(partition: string) {
    let openHandler: (() => unknown) | undefined
    const { listeners, target } = emitter({
      setWindowOpenHandler: (h: () => unknown) => (openHandler = h),
    })
    hardenEmbedGuest(target as unknown as WebContents, partition, () => HOST)
    return { listeners, open: () => openHandler!() }
  }

  it("opens no windows", () => {
    expect(guest(WEB_EMBED_PARTITION).open()).toEqual({ action: "deny" })
  })

  it("keeps a web page's main frame on https or loopback pages", () => {
    const { listeners } = guest(WEB_EMBED_PARTITION)
    const navigate = (url: string, isMainFrame = true) => emit(listeners, "will-navigate", { url, isMainFrame })
    expect(navigate("https://example.com/next")).toBe(false)
    expect(navigate("http://example.com/")).toBe(true)
    expect(navigate(`runbook-asset://${HOST}/index.html`)).toBe(true)
    expect(navigate("file:///etc/hosts")).toBe(true)
    // The page's own subframes are its business.
    expect(navigate("http://example.com/", false)).toBe(false)
    expect(emit(listeners, "will-redirect", { url: "file:///etc/hosts", isMainFrame: true })).toBe(true)
  })

  it("keeps a local page in the open runbook's assets", () => {
    const { listeners } = guest(LOCAL_EMBED_PARTITION)
    const navigate = (url: string) => emit(listeners, "will-navigate", { url, isMainFrame: true })
    expect(navigate(`runbook-asset://${HOST}/other.html`)).toBe(false)
    expect(navigate("https://example.com/")).toBe(true)
    expect(navigate("runbook-asset://rother/index.html")).toBe(true)
  })

  it("lets the page unload despite beforeunload, and picks no Bluetooth device", () => {
    const { listeners } = guest(WEB_EMBED_PARTITION)
    expect(emit(listeners, "will-prevent-unload")).toBe(true)

    const picked: string[] = []
    expect(emit(listeners, "select-bluetooth-device", {}, [{ deviceId: "d1" }], (id: string) => picked.push(id))).toBe(true)
    expect(picked).toEqual([""])
  })
})
