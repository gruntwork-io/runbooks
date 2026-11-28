import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentView, SessionSummary, SessionView } from "@runbooks/core/protocol"
import { FollowingContext } from "./following.ts"
import { type Live, makeLiveStore } from "./live.ts"
import { Runbook } from "./runbook.tsx"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore } from "./trust.ts"

// What the runbook page says of the runbook on disk: a reload the session
// holds back, and a watch that failed, as the engine sends them, rendered
// to the markup the page would hold.

const RUNBOOK = "/work/demo/runbook.mdx"
const SPAN = { start: { line: 3, column: 1 }, end: { line: 3, column: 20 } }

const session = Schema.decodeUnknownSync(SessionSummary)({
  session: "s-1",
  name: "demo",
  path: RUNBOOK,
  blocks: 1,
})

/** The runbook the page draws: one task, `deploy`. */
const document = Schema.decodeUnknownSync(DocumentView)({
  hash: `sha256:${"0".repeat(64)}`,
  tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
  blocks: [
    {
      _tag: "Configured",
      index: 0,
      tag: "Example",
      block: "Example",
      class: "task",
      id: "deploy",
      span: SPAN,
      step: true,
      effects: [],
    },
  ],
  warnings: [],
})

const decodeHeld = Schema.decodeUnknownSync(SessionView.fields.reloadHeld)
const decodeUnwatched = Schema.decodeUnknownSync(SessionView.fields.unwatched)

const UNWATCHED =
  "Runbooks could not watch /work/demo/runbook.mdx, or the files it names, for changes (ENOSPC: System limit for number of file watchers reached), so saving them shows nothing here. Linux's limit on file watches was reached: raise fs.inotify.max_user_watches, then open the runbook again."

/** The page, the window following a session as `shown` says, as JSON the engine sends. */
const page = (
  shown: { readonly held?: unknown; readonly unwatched?: unknown; readonly ended?: string } = {},
) => {
  const live: Live = {
    blocks: new Map(),
    ...(shown.held === undefined ? {} : { reloadHeld: decodeHeld(shown.held) }),
    ...(shown.unwatched === undefined ? {} : { unwatched: decodeUnwatched(shown.unwatched) }),
    ...(shown.ended === undefined ? {} : { ended: shown.ended }),
  }
  const store = makeLiveStore()
  store.set(live)
  return renderToStaticMarkup(
    <FollowingContext
      value={{
        live: store,
        settings: makeSettingsStore(undefined),
        trusting: makeTrustingStore(),
        act: () => Effect.succeed(undefined),
        trust: () => Effect.void,
      }}
    >
      <Runbook session={session} document={document} />
    </FollowingContext>,
  )
}

const configError = (file: string, line: number, message: string) => ({
  _tag: "ConfigError",
  code: "syntax",
  message,
  location: { file, span: { start: { line, column: 1 }, end: { line, column: 9 } } },
})

describe("what the page says of the runbook on disk", () => {
  it("names the blocks a held reload waits for, each linked to its frame as a block's waits are", () => {
    const shown = page({ held: { _tag: "Running", blocks: ["deploy", "gone"] } })
    expect(shown).toContain('aria-label="Reload held back"')
    expect(shown).toContain(
      "<p>This runbook changed on disk. It reloads once these blocks stop running:</p>",
    )
    expect(shown).toContain('<a href="#runbook-block-deploy" class="block-link">deploy</a>')
    // A block the page draws no frame for is its id, as a block's waits show one.
    expect(shown).toContain('<code class="block-link">gone</code>')
  })

  it("says the saved runbook has errors, each with its file and line, as the window shows a block's", () => {
    const shown = page({
      held: {
        _tag: "Invalid",
        errors: [
          configError(RUNBOOK, 7, "Expected a closing tag for `<Run>`."),
          configError("/work/demo/scripts/setup.yml", 2, "The YAML does not parse."),
        ],
        warnings: [],
      },
    })
    expect(shown).toContain(
      "This runbook changed on disk, but the saved runbook has errors, so this is still the runbook as it was. It reloads once they are fixed:",
    )
    expect(shown).toContain("<li>Line 7: Expected a closing tag for `&lt;Run&gt;`.</li>")
    expect(shown).toContain("<li>scripts/setup.yml, line 2: The YAML does not parse.</li>")
  })

  it("says why the saved runbook could not be read", () => {
    expect(
      page({
        held: { _tag: "Unreadable", message: "There is no file at /work/demo/runbook.mdx." },
      }),
    ).toContain(
      "This runbook changed on disk, but the saved runbook could not be read, so this is still the runbook as it was: There is no file at /work/demo/runbook.mdx.",
    )
  })

  it("says nothing of a reload once none is held", () => {
    expect(page()).not.toContain("changed on disk")
    expect(page()).not.toContain("Reload held back")
  })

  it("says the session stopped watching, and what to do, beside a reload it holds back", () => {
    const shown = page({
      held: { _tag: "Running", blocks: ["deploy"] },
      unwatched: { message: UNWATCHED },
    })
    expect(shown).toContain(`<p class="unwatched">${UNWATCHED.replaceAll("'", "&#x27;")}</p>`)
    expect(shown).toContain('aria-label="Reload held back"')
    expect(page({ unwatched: { message: UNWATCHED } })).toContain('<p class="unwatched">')
  })

  it("sits above the runbook's box, so nothing the author styles covers it", () => {
    const shown = page({
      held: { _tag: "Running", blocks: ["deploy"] },
      unwatched: { message: UNWATCHED },
    })
    const box = shown.indexOf('class="runbook-body"')
    for (const note of ['aria-label="Reload held back"', 'class="unwatched"']) {
      expect(shown.indexOf(note)).toBeGreaterThan(-1)
      expect(shown.indexOf(note)).toBeLessThan(box)
    }
  })

  it("says neither once the window stopped following the session, when nothing reloads", () => {
    const shown = page({
      held: { _tag: "Running", blocks: ["deploy"] },
      unwatched: { message: UNWATCHED },
      ended: "This runbook's session closed, so the window shows it as it was left.",
    })
    expect(shown).not.toContain("Reload held back")
    expect(shown).not.toContain("unwatched")
  })
})
