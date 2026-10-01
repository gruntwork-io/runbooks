/**
 * E2E tests for runbook assets served over the runbook-asset:// protocol.
 *
 * Opens a throwaway runbook whose assets/ folder holds a tiny PNG, a generated
 * 2-minute PCM WAV (about 10 MB) and a small checked-in WebM, and checks in the
 * real renderer that each one loads and that audio and video can seek.
 * Seeking needs the handler's Range support (electron/main/asset-range.ts).
 * The WAV is large enough that a seek near its end needs a second range
 * request, which also needs the scheme's `standard` privilege
 * (electron/main/index.ts).
 *
 * Prerequisites: run `electron-vite build` first (expects ./dist/main/index.js).
 *
 * Run with:
 *   bunx playwright test --config electron/e2e/playwright.config.ts 'runbook-assets\.spec'
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")
const MAIN_ENTRY = path.join(ROOT, "dist/main/index.js")

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

// A 4-second 64x48 VP8 WebM with a keyframe every second (ffmpeg testsrc).
const WEBM = path.join(__dirname, "fixtures/testsrc-4s.webm")

const WAV_SECONDS = 120

/** A mono 16-bit PCM WAV holding `seconds` of a 440 Hz tone. */
function wav(seconds: number, sampleRate = 44_100): Buffer {
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

const RUNBOOK = `# Runbook assets

<img src="./assets/pixel.png" width="40" alt="pixel" />

<img src="./assets/icons/tiny pixel.png" width="40" alt="nested" />

<audio src="./assets/tone.wav" controls preload="auto" />

<video src="./assets/testsrc.webm" controls preload="auto" muted />
`

interface MediaState {
  readyState: number
  error: string | null
  duration: number
  currentTime: number
  seekable: [number, number][]
}

/**
 * Wait until the media element matching `selector` has metadata (readyState
 * >= HAVE_METADATA) or has failed, then report its state. With `seekTo`, seek
 * there first and wait for the seek to finish or fail.
 */
function mediaState(page: Page, selector: string, seekTo?: number): Promise<MediaState> {
  return page.evaluate(
    async ({ selector, seekTo }) => {
      const el = document.querySelector(selector) as HTMLMediaElement
      const settle = (event: string) =>
        new Promise<void>((resolve) => {
          el.addEventListener(event, () => resolve(), { once: true })
          el.addEventListener("error", () => resolve(), { once: true })
          setTimeout(resolve, 20_000)
        })
      if (el.readyState < HTMLMediaElement.HAVE_METADATA && !el.error)
        await settle("loadedmetadata")
      if (seekTo !== undefined && !el.error) {
        const seeked = settle("seeked")
        el.currentTime = seekTo
        await seeked
      }
      const seekable: [number, number][] = []
      for (let i = 0; i < el.seekable.length; i++)
        seekable.push([el.seekable.start(i), el.seekable.end(i)])
      return {
        readyState: el.readyState,
        error: el.error ? `${el.error.code} ${el.error.message}` : null,
        duration: el.duration,
        currentTime: el.currentTime,
        seekable,
      }
    },
    { selector, seekTo },
  )
}

test.describe("Runbook assets", () => {
  let tmpDir: string
  let runbookDir: string

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-assets-e2e-"))
    runbookDir = path.join(tmpDir, "runbook")
    fs.mkdirSync(path.join(runbookDir, "assets"), { recursive: true })
    fs.writeFileSync(path.join(runbookDir, "runbook.mdx"), RUNBOOK)
    fs.writeFileSync(path.join(runbookDir, "assets/pixel.png"), PNG)
    fs.mkdirSync(path.join(runbookDir, "assets/icons"))
    fs.writeFileSync(path.join(runbookDir, "assets/icons/tiny pixel.png"), PNG)
    fs.writeFileSync(path.join(runbookDir, "assets/tone.wav"), wav(WAV_SECONDS))
    fs.copyFileSync(WEBM, path.join(runbookDir, "assets/testsrc.webm"))
  })

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
      // --user-data-dir isolates the single-instance lock and trust state.
      args: [MAIN_ENTRY, `--user-data-dir=${path.join(tmpDir, "user-data")}`, runbookDir],
      env: {
        ...process.env,
        ELECTRON_NO_UPDATER: "1",
        RUNBOOKS_NO_TELEMETRY: "1",
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: "Runbook assets" })).toBeVisible({
      timeout: 60_000,
    })
    return { app, page }
  }

  test("loads images, audio and video from the runbook's assets folder", async () => {
    const { app, page } = await launch()
    try {
      // A subfolder and a space exercise the URL's canonical form (host
      // `assets`, `%20`) on its way back to a file path.
      for (const [alt, src] of [
        ["pixel", "runbook-asset://assets/pixel.png"],
        ["nested", "runbook-asset://assets/icons/tiny pixel.png"],
      ]) {
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
    } finally {
      await app.close()
    }
  })

  // Without 206 responses Chromium treats the WAV as a live stream, with no
  // duration and nothing seekable. With them but a non-standard scheme, the
  // second range request fails with PIPELINE_ERROR_READ.
  test("seeks within audio and video", async () => {
    const { app, page } = await launch()
    try {
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
      }
    } finally {
      await app.close()
    }
  })
})
