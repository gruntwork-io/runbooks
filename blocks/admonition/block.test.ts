import { describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { BlockId } from "@runbooks/blocks-core/contract"
import type { ConfigError } from "@runbooks/core/document/configError"
import { serveEngine } from "@runbooks/core/handlers"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { BlockView, DocumentView } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { testCredentialProviders } from "@runbooks/core/test-utils/TestCredentialProviders"
import { testFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import { testSessionStore } from "@runbooks/core/test-utils/TestSessionStore"
import { testSettingsStore } from "@runbooks/core/test-utils/TestSettingsFile"
import { makeTestSpawner } from "@runbooks/core/test-utils/TestSpawner"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { admonition } from "./block.ts"

// Admonition through the engine, as a window sees it: the real parser and
// the real session, over an in-memory file system. A display block gives
// the runbook nothing and has no lifecycle, so what there is to see is
// what the document says of it, and the props it sends the view.

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

interface Opened {
  readonly document: DocumentView
  /** What the window is sent for the block with id `block`. */
  readonly view: (block: string) => Effect.Effect<BlockView, unknown>
}

/** An untrusted session of `runbook`: a display block needs no trust to be drawn. */
const opened = <A>(runbook: string, use: (s: Opened) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person")
        const open = yield* client.OpenSession({ path: RUNBOOK })
        if (open._tag !== "Opened") throw new Error(open.errors.map((e) => e.message).join())
        const { session } = open.session
        const document = yield* client.GetDocument({ session })
        return yield* use({
          document,
          view: (block) => client.GetBlock({ session, block: blockId(block) }),
        })
      }).pipe(
        Effect.provide(
          serveEngine({
            registry: { ...TOY_REGISTRY, Admonition: admonition },
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: { PATH: "/usr/bin:/bin", HOME: "/home/someone" },
          }),
        ),
        Effect.provide(testCredentialProviders({}, [])),
        Effect.provide(testSettingsStore()),
        Effect.provide(testSessionStore()),
        Effect.provide(makeTestSpawner()),
        Effect.provide(Layer.succeed(FileSystem, testFileSystem({ [RUNBOOK]: runbook }, ["/rb"]))),
      ),
    ),
  )

/** Each misconfigured block's errors: its code, line and message. */
const errorsIn = (runbook: string) =>
  opened(runbook, ({ document }) =>
    Effect.succeed(
      document.blocks.flatMap((block) =>
        block._tag === "Misconfigured"
          ? block.errors.map((e: ConfigError) => [e.code, e.location.span.start.line, e.message])
          : [],
      ),
    ),
  )

describe("Admonition", () => {
  it("sends the window its props as written, title and description included, and no status", async () => {
    const runbook = [
      "# Setup",
      "",
      '<Admonition id="careful" type="warning" title="Careful" description="It costs money." closable={true} confirmationText="I understand">',
      "Read the **pricing** page.",
      "</Admonition>",
    ].join("\n")
    const { block, shown } = await opened(runbook, ({ document, view }) =>
      Effect.map(view("careful"), (got) => ({ block: document.blocks[0], shown: got })),
    )
    expect(block).toMatchObject({
      _tag: "Configured",
      tag: "Admonition",
      class: "display",
      step: false,
      effects: [],
      props: {
        type: "warning",
        title: "Careful",
        description: "It costs money.",
        closable: true,
        confirmationText: "I understand",
      },
    })
    expect(shown.status).toBeUndefined()
    expect(shown.actions).toEqual([])
  })

  it("is drawn without an id, and is never a progress step", async () => {
    const blocks = await opened(
      '<Admonition type="note" description="One." />\n\n<Admonition type="danger" />',
      ({ document }) => Effect.succeed(document.blocks),
    )
    expect(blocks.map((b) => [b._tag, b.id, b._tag === "Configured" && b.step])).toEqual([
      ["Configured", undefined, false],
      ["Configured", undefined, false],
    ])
  })

  it("needs a type, one of the four", async () => {
    expect(
      await errorsIn(
        [
          '<Admonition title="No type" />',
          "",
          '<Admonition type="tip" />',
          "",
          '<Admonition type="note" closable="yes" confirmationText="" />',
        ].join("\n"),
      ),
    ).toEqual([
      ["badProp", 1, "<Admonition> needs the `type` prop."],
      [
        "badProp",
        3,
        'the `type` prop of <Admonition>: Expected "note" | "info" | "warning" | "danger"',
      ],
      ["badProp", 5, "the `closable` prop of <Admonition>: Expected boolean"],
      [
        "badProp",
        5,
        "the `confirmationText` prop of <Admonition>: Expected a value with a length of at least 1",
      ],
    ])
  })

  it("hides for good under a storageKey, which goes with allowPermanentHide and confirmationText", async () => {
    const fine = await opened(
      '<Admonition type="info" confirmationText="Got it" allowPermanentHide={true} storageKey="welcome" />',
      ({ document }) => Effect.succeed(document.blocks[0]),
    )
    expect(fine).toMatchObject({
      _tag: "Configured",
      props: {
        type: "info",
        confirmationText: "Got it",
        allowPermanentHide: true,
        storageKey: "welcome",
      },
    })
    expect(
      await errorsIn(
        [
          '<Admonition type="info" allowPermanentHide={true} />',
          "",
          '<Admonition type="info" storageKey="welcome" />',
          "",
          `<Admonition type="info" confirmationText="Got it" allowPermanentHide={true} storageKey="${"k".repeat(65)}" />`,
          "",
          '<Admonition type="info" confirmationText="Got it" allowPermanentHide={false} storageKey="welcome" />',
        ].join("\n"),
      ),
    ).toEqual([
      [
        "badProp",
        1,
        'the `allowPermanentHide` prop of <Admonition>: it needs `confirmationText`: its "Don\'t show me this again" box is under that button; it needs `storageKey`, the name the hide is kept under, such as storageKey="welcome"',
      ],
      [
        "badProp",
        3,
        "the `storageKey` prop of <Admonition>: it names a hide, so it does nothing without allowPermanentHide={true}",
      ],
      [
        "badProp",
        5,
        "the `storageKey` prop of <Admonition>: Expected a value with a length of at most 64",
      ],
      [
        "badProp",
        7,
        "the `storageKey` prop of <Admonition>: it names a hide, so it does nothing without allowPermanentHide={true}",
      ],
    ])
  })

  it("ignores inputsId, and warns of the references in its text: nothing fills them in", async () => {
    const parsed = await opened(
      '<Admonition type="info" title="Hello {{ .inputs.name }}" inputsId="config" />',
      ({ document }) => Effect.succeed(document),
    )
    expect(parsed.warnings.map((w) => [w.code, w.message])).toEqual([
      [
        "unfilledReference",
        "`title` on <Admonition> reads {{ .inputs.name }}, which nothing fills in: a display block's text shows as written.",
      ],
      ["unknownProp", "<Admonition> has no `inputsId` prop, so it is ignored."],
    ])
    expect(parsed.blocks[0]).toMatchObject({
      props: { type: "info", title: "Hello {{ .inputs.name }}" },
    })
  })
})
