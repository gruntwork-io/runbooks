/**
 * A runbook's assets, as the window shows them: an image, audio or video in
 * the runbook's assets/ folder loads from main's `runbook-asset:` scheme,
 * and audio and video can seek; nothing outside the folder, or for another
 * session, is served; and the page loads no image or media from anywhere
 * else.
 *
 * Each test copies e2e/runbooks/media/ into its own output folder and
 * writes the generated assets beside its checked-in WebM: a 1x1 PNG, the
 * same PNG in a nested folder with a space in its name, a PNG outside
 * assets/ with a symlink to it inside, and a 2-minute WAV, about 1.9 MB.
 *
 * Runs against the build in app-out/: `just app-test-e2e` builds it first.
 * Each test launches it through the shared fixture (fixtures.ts).
 */
import fs from "node:fs"
import path from "node:path"
import type { ElectronApplication, Page, TestInfo } from "@playwright/test"
import { readFromMain } from "../electron/e2e/main-process.ts"
import { expect, type Launched, type LaunchOptions, runAsPage, test } from "./fixtures.ts"

const FIXTURE = path.join(import.meta.dirname, "runbooks", "media")

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const WAV_SECONDS = 120

/** A mono 16-bit PCM WAV holding `seconds` of a 440 Hz tone. */
function wav(seconds: number, sampleRate = 8_000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2)
  for (let i = 0; i < data.length / 2; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8_000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** The fixture runbook, with its generated assets, in the test's output folder. */
function mediaRunbook(testInfo: TestInfo): string {
  const runbook = testInfo.outputPath("media")
  fs.cpSync(FIXTURE, runbook, { recursive: true })
  const assets = path.join(runbook, "assets")
  fs.writeFileSync(path.join(assets, "pixel.png"), PNG)
  fs.mkdirSync(path.join(assets, "icons"))
  fs.writeFileSync(path.join(assets, "icons", "tiny pixel.png"), PNG)
  fs.writeFileSync(path.join(assets, "tone.wav"), wav(WAV_SECONDS))
  fs.writeFileSync(path.join(runbook, "outside.png"), PNG)
  fs.symlinkSync("../outside.png", path.join(assets, "link.png"))
  return runbook
}

/** Launches the app on the fixture runbook and waits for its heading. */
async function openMedia(
  launch: (options?: LaunchOptions) => Promise<Launched>,
  testInfo: TestInfo,
): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launch({ args: [mediaRunbook(testInfo)] })
  await expect(page.getByRole("heading", { name: "Runbook assets" })).toBeVisible()
  return { app, page }
}

/** A session id: the host of a runbook's asset URLs. */
const SESSION = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

interface MediaState {
  readyState: number
  error: string | null
  duration: number
  currentTime: number
  seekable: [number, number][]
  /** What was buffered once the metadata was in, before any seek. */
  bufferedBeforeSeek: [number, number][]
}

/**
 * Wait until the media element matching `selector` has metadata (readyState
 * >= HAVE_METADATA) or has failed, then report its state. With `seekTo`, seek
 * there first and wait for the seek to finish or fail.
 */
function mediaState(page: Page, selector: string, seekTo?: number): Promise<MediaState> {
  return page.evaluate(
    async ({ selector: mediaSelector, seekTo: seekTarget }) => {
      const el = document.querySelector(mediaSelector) as HTMLMediaElement
      const settle = (event: string) =>
        new Promise<void>((resolve) => {
          el.addEventListener(event, () => resolve(), { once: true })
          el.addEventListener("error", () => resolve(), { once: true })
          setTimeout(resolve, 20_000)
        })
      if (el.readyState < HTMLMediaElement.HAVE_METADATA && !el.error)
        await settle("loadedmetadata")
      const ranges = (list: TimeRanges) => {
        const found: [number, number][] = []
        for (let i = 0; i < list.length; i++) found.push([list.start(i), list.end(i)])
        return found
      }
      const bufferedBeforeSeek = ranges(el.buffered)
      if (seekTarget !== undefined && !el.error) {
        const seeked = settle("seeked")
        el.currentTime = seekTarget
        await seeked
      }
      const seekable = ranges(el.seekable)
      return {
        readyState: el.readyState,
        error: el.error ? `${el.error.code} ${el.error.message}` : null,
        duration: el.duration,
        currentTime: el.currentTime,
        seekable,
        bufferedBeforeSeek,
      }
    },
    { selector, seekTo },
  )
}

test.describe("a runbook's assets", () => {
  test("loads images, audio and video from the runbook's assets folder", async ({
    launch,
  }, testInfo) => {
    const { page } = await openMedia(launch, testInfo)
    // A subfolder and a space take the URL's path back to a file path.
    for (const [alt, src] of [
      ["pixel", new RegExp(`^runbook-asset://${SESSION}/pixel\\.png$`)],
      ["nested", new RegExp(`^runbook-asset://${SESSION}/icons/tiny pixel\\.png$`)],
    ] as const) {
      const img = page.locator(`img[alt="${alt}"]`)
      await expect(img).toHaveAttribute("src", src)
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
        .toBeGreaterThan(0)
    }

    const audio = await mediaState(page, "audio")
    expect(audio.error).toBeNull()
    expect(audio.readyState).toBeGreaterThanOrEqual(1)

    const video = await mediaState(page, "video")
    expect(video.error).toBeNull()
    expect(video.readyState).toBeGreaterThanOrEqual(1)

    // An image beside the runbook, outside assets/, stays text.
    await expect(page.locator(".runbook-body")).toContainText(
      "Image: beside the runbook (./outside.png)",
    )
    await expect(page.locator("img")).toHaveCount(2)
  })

  // Without 206 answers Chromium treats the WAV as a live stream, with no
  // duration and nothing seekable. An answer cut short of the range asked
  // for makes it end early (byteRange.ts).
  //
  // The audio loads only its metadata, so the seek reads past what Chromium
  // had: by a second range request, which fails unless the asset scheme is
  // `standard` (PIPELINE_ERROR_READ). Before the seek its end isn't buffered:
  // unless the scheme is `stream`, Chromium reads the whole file at once
  // (runbooks-reviewer on #651), so nothing else bounds what one asset reads.
  test("seeks within audio and video, the audio reading its end only for the seek", async ({
    launch,
  }, testInfo) => {
    const { page } = await openMedia(launch, testInfo)
    for (const [selector, seconds] of [
      ["audio", WAV_SECONDS],
      ["video", 4],
    ] as const) {
      const target = seconds - 1.5
      const state = await mediaState(page, selector, target)
      expect(state.error, selector).toBeNull()
      expect(state.duration, selector).toBeCloseTo(seconds, 1)
      expect(state.seekable, selector).toEqual([[0, expect.closeTo(seconds, 1)]])
      expect(state.currentTime, selector).toBeCloseTo(target, 0)
      if (selector === "audio")
        expect(
          state.bufferedBeforeSeek.filter(([, end]) => end >= target),
          selector,
        ).toEqual([])
    }
  })

  test("serves nothing for another session's host, or for a path out of assets/", async ({
    launch,
  }, testInfo) => {
    const { app, page } = await openMedia(launch, testInfo)
    const own = new URL((await page.locator('img[alt="pixel"]').getAttribute("src")) ?? "").host
    // A session id no session has: ids are random.
    const other = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b"
    const urls = [
      `runbook-asset://${own}/pixel.png`,
      `runbook-asset://${other}/pixel.png`,
      `runbook-asset://${own}/..%2Foutside.png`,
      `runbook-asset://${own}/%2e%2e%2Foutside.png`,
      `runbook-asset://${own}/link.png`,
    ]

    // As the page loads them: only the first, the control, loads.
    const loads = await runAsPage(
      app,
      `Promise.all(${JSON.stringify(urls)}.map((src) => new Promise((resolve) => {
        const img = new Image()
        img.addEventListener("load", () => resolve("loaded"))
        img.addEventListener("error", () => resolve("refused"))
        img.src = src
      })))`,
    )
    expect(loads).toEqual(["loaded", "refused", "refused", "refused", "refused"])

    // As main answers them: a 404 with no body.
    const answers = await readFromMain(
      app,
      async ({ BrowserWindow }, asked) => {
        const [appWindow] = BrowserWindow.getAllWindows()
        if (!appWindow) throw new Error("the app has no window")
        return Promise.all(
          asked.map(async (url) => {
            const res = await appWindow.webContents.session.fetch(url)
            return [res.status, (await res.arrayBuffer()).byteLength]
          }),
        )
      },
      urls,
    )
    expect(answers).toEqual([
      [200, PNG.length],
      [404, 0],
      [404, 0],
      [404, 0],
      [404, 0],
    ])
  })

  test("loads no image or media from anywhere but a runbook's assets", async ({ launch }) => {
    const { app } = await launch()
    const violations = await runAsPage(
      app,
      `new Promise((resolve) => {
        const seen = []
        document.addEventListener("securitypolicyviolation", (event) => {
          seen.push([event.effectiveDirective, event.blockedURI])
          if (seen.length === 3) resolve(seen.sort())
        })
        const remote = new Image()
        remote.src = "https://example.invalid/pixel.png"
        const inline = new Image()
        inline.src = "data:image/png;base64,${PNG.toString("base64")}"
        const audio = new Audio()
        audio.src = "https://example.invalid/tone.wav"
        setTimeout(() => resolve(seen.sort()), 5_000)
      })`,
    )
    expect(violations).toEqual([
      ["img-src", "data"],
      ["img-src", "https://example.invalid/pixel.png"],
      ["media-src", "https://example.invalid/tone.wav"],
    ])
  })
})
