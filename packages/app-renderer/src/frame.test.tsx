import { describe, expect, it } from "bun:test"
import { Effect, Queue, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import type { View, ViewRequest } from "@runbooks/blocks/views"
import {
  BlockView,
  DocumentBlock,
  type DocumentView,
  SessionId,
  Settings,
} from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, fails, fakeMain } from "./fakeMain.ts"
import { buttonsFor, scrollToBlock, ViewsContext } from "./frame.tsx"
import { type Following, FollowingContext, followingOf } from "./following.ts"
import { follow, type Live, makeLiveStore } from "./live.ts"
import { Markdown } from "./markdown.tsx"
import { makeSettingsStore } from "./settings.ts"
import { makeTrustingStore } from "./trust.ts"

// The frame the walk draws each block in, over document blocks as the
// engine sends them, rendered to the markup the page would hold.

type TreeNode = DocumentView["tree"]

const RUNBOOK = "/work/demo/runbook.mdx"
const SESSION = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const SPAN = { start: { line: 3, column: 1 }, end: { line: 5, column: 3 } }

/** The settings as the engine sends them, instruction mode off. */
const SETTINGS = {
  theme: "system",
  instructionMode: false,
  runbookWidth: null,
  askAboutGeneratedFiles: true,
  caBundleFile: null,
  proxy: null,
  agentAccess: false,
  confirmAgentRuns: true,
  recentGitHubHosts: [],
  lastSelectedGitHubHost: null,
  recentGitLabHosts: [],
  lastSelectedGitLabHost: null,
}

const placed = (fields: Record<string, unknown>): DocumentBlock =>
  Schema.decodeUnknownSync(DocumentBlock)({
    _tag: "Configured",
    index: 0,
    tag: "Example",
    block: "Example",
    class: "task",
    span: SPAN,
    step: true,
    effects: [],
    ...fields,
  })

const text = (value: string): TreeNode => ({
  type: "paragraph",
  children: [{ type: "text", value }],
})

/** The page with `block` alone in it, `children` as its markdown. */
const framed = (block: DocumentBlock, ...children: TreeNode[]) =>
  renderToStaticMarkup(
    <Markdown
      document={{
        tree: { type: "root", children: [{ type: "block", index: 0, children }] },
        blocks: [block],
      }}
      runbook={RUNBOOK}
      session={SESSION}
    />,
  )

describe("a block's frame", () => {
  it("marks a progress step, and draws no mark on a block that is not one", () => {
    expect(framed(placed({ id: "setup" }))).toContain('aria-label="Step: not done"')
    expect(framed(placed({ class: "display", step: false }))).not.toContain("Step:")
    expect(framed(placed({ id: "peek", step: false }))).not.toContain("Step:")
  })

  it("draws a misconfigured block with no step mark: it is never a step", () => {
    const shown = framed(
      placed({
        _tag: "Misconfigured",
        id: "setup",
        errors: [
          {
            _tag: "ConfigError",
            code: "badProp",
            message: "set `command`",
            location: { file: RUNBOOK, span: SPAN },
          },
        ],
      }),
    )
    expect(shown).toContain("Line 3: set `command`")
    expect(shown).not.toContain("Step:")
  })

  it("gives a block with an id an anchor that a link to it scrolls to", () => {
    expect(framed(placed({ id: "setup" }))).toContain('id="runbook-block-setup"')
  })

  it("draws a task's markdown in its body", () => {
    expect(framed(placed({ id: "setup" }), text("Runs the setup."))).toContain(
      '<div class="block-body"><p>Runs the setup.</p></div>',
    )
  })

  it("draws a form or a credential block with no view, its markdown, and a line that says so", () => {
    const form = framed(placed({ id: "config", class: "form" }), text("Your settings."))
    expect(form).toContain("Your settings.")
    expect(form).toContain("The window can&#x27;t show this form&#x27;s fields yet.")
    const credential = framed(placed({ id: "cloud", class: "credential" }), text("Sign in first."))
    expect(credential).toContain("Sign in first.")
    expect(credential).toContain("The window can&#x27;t show this sign-in yet.")
  })

  it("draws a display block's markdown, with no status and no step", () => {
    const shown = framed(placed({ class: "display", step: false }), text("Read this first."))
    expect(shown).toContain("Read this first.")
    expect(shown).not.toContain("can&#x27;t show")
  })
})

/** A block's view as the engine sends it, for `following`. */
const view = (
  block: string,
  status: Record<string, unknown>,
  fields: Record<string, unknown> = {},
) =>
  Schema.decodeUnknownSync(BlockView)({
    block,
    tag: "Example",
    class: "task",
    status,
    actions: [],
    outputs: {},
    ...fields,
  })

/** The window following a session the engine holds `views` of, as `follow` would show it. */
const followingViews = (...views: BlockView[]): Following => {
  const live = makeLiveStore()
  live.set({ blocks: new Map(views.map((shown) => [shown.block, shown])) })
  return {
    live,
    settings: makeSettingsStore(undefined),
    trusting: makeTrustingStore(),
    act: () => Effect.succeed(undefined),
    trust: () => Effect.void,
  }
}

/** The page with `blocks` in it, in order, the window following `following`. */
const page = (following: Following, ...blocks: DocumentBlock[]) =>
  renderToStaticMarkup(
    <FollowingContext value={following}>
      <Markdown
        document={{
          tree: {
            type: "root",
            children: blocks.map((_, index) => ({ type: "block", index, children: [] })),
          },
          blocks: blocks.map((block, index) => ({ ...block, index })),
        }}
        runbook={RUNBOOK}
        session={SESSION}
      />
    </FollowingContext>,
  )

describe("a block's frame, as the engine has the block", () => {
  it.each([
    [{ _tag: "Idle" }, "Ready"],
    [{ _tag: "NeedsInput", fields: ["region", "token"] }, "Needs input: region, token"],
    [{ _tag: "Running" }, "Running"],
    [{ _tag: "Done", outcome: "success" }, "Done"],
    [{ _tag: "Done", outcome: "warning" }, "Done, with warnings"],
    [
      {
        _tag: "Failed",
        error: { _tag: "TaskFailed", message: "The script exited with code 3.", exitCode: 3 },
      },
      "Failed: The script exited with code 3.",
    ],
    [
      { _tag: "Failed", error: { _tag: "TaskFailed", message: "tofu was not found" } },
      "Failed: tofu was not found",
    ],
    [{ _tag: "Failed", error: { _tag: "TaskCancelled" } }, "Cancelled"],
    [
      { _tag: "Failed", error: { _tag: "TaskTimedOut", afterMillis: 90_000 } },
      "Timed out after 90 seconds",
    ],
    [
      { _tag: "Failed", error: { _tag: "PropError", prop: "path", message: "names no file" } },
      "Failed: `path` names no file",
    ],
    [
      { _tag: "Failed", error: { _tag: "TaskBlocked", by: ["build", "test"] } },
      "Failed: it was blocked by build, test",
    ],
    [
      {
        _tag: "Failed",
        error: {
          _tag: "PathOutsideRoot",
          root: "working",
          path: "../x",
          message: "../x is outside the working folder",
        },
      },
      "Failed: ../x is outside the working folder",
    ],
    [
      {
        _tag: "Failed",
        error: { _tag: "CredentialError", kind: "expired", message: "The session expired." },
      },
      "Failed: The session expired.",
    ],
    [{ _tag: "Misconfigured" }, "Its configuration has errors, so it doesn&#x27;t run."],
  ])("shows the status %j as %s", (status, shown) => {
    expect(page(followingViews(view("setup", status)), placed({ id: "setup" }))).toContain(
      `<p class="block-status">${shown}</p>`,
    )
  })

  it("shows no status for a block the engine has not sent yet, or one with no lifecycle", () => {
    expect(page(followingViews(), placed({ id: "setup" }))).not.toContain("block-status")
    expect(page(followingViews(), placed({ class: "display", step: false }))).not.toContain(
      "block-status",
    )
  })

  it("marks a step done once its block is done, and not before", () => {
    const done = followingViews(view("setup", { _tag: "Done", outcome: "success" }))
    expect(page(done, placed({ id: "setup" }))).toContain('aria-label="Step: done"')
    const failed = followingViews(
      view("setup", { _tag: "Failed", error: { _tag: "TaskCancelled" } }),
    )
    expect(page(failed, placed({ id: "setup" }))).toContain('aria-label="Step: not done"')
  })

  it("says it waits for trust, and links each block it waits for, which scrolls to it", () => {
    const shown = page(
      followingViews(
        view("deploy", {
          _tag: "Blocked",
          by: [
            { _tag: "Untrusted" },
            { _tag: "WaitingFor", block: "build", capability: "run" },
            { _tag: "WaitingFor", block: "config", capability: "values" },
          ],
        }),
      ),
      placed({ id: "deploy" }),
      placed({ id: "build" }),
      placed({ id: "config", class: "form" }),
    )
    expect(shown).toContain("Waiting for you to trust this runbook.")
    expect(shown).toContain("Waiting for:")
    expect(shown).toContain(
      '<a href="#runbook-block-build" class="block-link">build</a> to run successfully',
    )
    expect(shown).toContain(
      '<a href="#runbook-block-config" class="block-link">config</a> to have its values',
    )
  })

  it("names a block it waits for as text when the page draws no frame for it", () => {
    const shown = page(
      followingViews(
        view("deploy", {
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: "gone", capability: "run" }],
        }),
      ),
      placed({ id: "deploy" }),
    )
    expect(shown).toContain('<code class="block-link">gone</code> to run successfully')
  })

  it("scrolls a block's frame to the middle of the window", () => {
    const scrolled: Array<[string, ScrollIntoViewOptions]> = []
    scrollToBlock(
      {
        getElementById: (id) => ({ scrollIntoView: (options) => scrolled.push([id, options]) }),
      },
      "build",
    )
    expect(scrolled).toEqual([["runbook-block-build", { behavior: "smooth", block: "center" }]])
  })

  it("folds a done task or credential block that asks to, to its header", () => {
    const done = { _tag: "Done", outcome: "success" }
    for (const kind of ["task", "credential"]) {
      const shown = page(
        followingViews(view("setup", done, { class: kind })),
        placed({ id: "setup", class: kind, autoCollapse: true, description: "Sets it up." }),
      )
      expect(shown).toContain('data-folded="true"')
      expect(shown).toContain('aria-expanded="false"')
      expect(shown).toContain('<span class="block-id">setup</span>')
      expect(shown).not.toContain("Sets it up.")
    }
  })

  it("does not fold a block that is not done, one that doesn't ask to, or a form", () => {
    const shown = (fields: Record<string, unknown>, status: Record<string, unknown>) =>
      page(followingViews(view("setup", status, fields)), placed({ id: "setup", ...fields }))
    const done = { _tag: "Done", outcome: "success" }
    expect(shown({ autoCollapse: true }, { _tag: "Running" })).not.toContain('data-folded="true"')
    expect(shown({}, done)).not.toContain('data-folded="true"')
    expect(shown({ autoCollapse: false }, done)).not.toContain('data-folded="true"')
    expect(shown({ autoCollapse: true, class: "form" }, done)).not.toContain('data-folded="true"')
  })
})

describe("a task's default view", () => {
  it("offers what the engine says the task takes now, and nothing while it is blocked", () => {
    const shown = (status: Record<string, unknown>, actions: string[]) =>
      page(followingViews(view("setup", status, { actions })), placed({ id: "setup" }))
    expect(shown({ _tag: "Idle" }, ["run"])).toContain('<button type="button">Run</button>')
    const running = shown({ _tag: "Running" }, ["cancel", "reset"])
    expect(running).toContain('<button type="button">Cancel</button>')
    expect(running).toContain('<button type="button">Reset</button>')
    expect(running).not.toContain(">Run<")
    expect(shown({ _tag: "Blocked", by: [{ _tag: "Untrusted" }] }, [])).not.toContain("<button")
  })

  it("asks the engine for each action as the view asks for it", () => {
    expect(
      buttonsFor(["run", "cancel", "reset", "setValues", "confirmValues", "credential"]),
    ).toEqual([
      { label: "Run", request: { _tag: "RunBlock" } },
      { label: "Cancel", request: { _tag: "CancelBlock" } },
      { label: "Reset", request: { _tag: "ResetBlock" } },
    ])
  })

  it("shows its latest run's log, and says which lines when it shows part of it", () => {
    const log = (offset: number, total: number, texts: string[]) =>
      page(
        followingViews(
          view(
            "setup",
            { _tag: "Running" },
            {
              log: {
                offset,
                total,
                lines: texts.map((line) => ({ stream: "stdout", text: line })),
              },
            },
          ),
        ),
        placed({ id: "setup" }),
      )
    const whole = log(0, 2, ["one", "two"])
    expect(whole).toContain(
      '<pre class="block-log" aria-label="Log"><span class="log-stdout">one\n</span><span class="log-stdout">two\n</span></pre>',
    )
    expect(whole).not.toContain("Lines ")
    expect(log(300, 500, ["three hundred and one"])).toContain(
      '<p class="block-log-part">Lines 301 to 301 of 500.</p>',
    )
  })

  it("shows the outputs its latest run gave, each as text, and a hidden one as hidden", () => {
    const shown = (outputs: Record<string, unknown>) =>
      page(
        followingViews(view("setup", { _tag: "Done", outcome: "success" }, { outputs })),
        placed({ id: "setup" }),
      )
    expect(
      shown({
        region: { _tag: "Shown", value: "us-east-1" },
        banner: { _tag: "Shown", value: "<b>bold</b>" },
        token: { _tag: "Hidden" },
      }),
    ).toContain(
      '<dl class="block-outputs" aria-label="Outputs"><dt>region</dt><dd>us-east-1</dd><dt>banner</dt><dd>&lt;b&gt;bold&lt;/b&gt;</dd><dt>token</dt><dd class="block-output-hidden">Hidden: it is sensitive.</dd></dl>',
    )
    expect(shown({})).not.toContain("Outputs")
  })

  it("draws a block's own view, with its props and status, in place of its class's", () => {
    const Toy: View<Schema.Json> = ({ props, status, children }) => (
      <div className="toy">
        {JSON.stringify(props)} {status?._tag} {children}
      </div>
    )
    const shown = renderToStaticMarkup(
      <ViewsContext value={{ Example: Toy }}>
        <FollowingContext
          value={followingViews(view("setup", { _tag: "Idle" }, { actions: ["run"] }))}
        >
          <Markdown
            document={{
              tree: {
                type: "root",
                children: [{ type: "block", index: 0, children: [text("Its markdown.")] }],
              },
              blocks: [placed({ id: "setup", props: { command: "echo hi" } })],
            }}
            runbook={RUNBOOK}
            session={SESSION}
          />
        </FollowingContext>
      </ViewsContext>,
    )
    expect(shown).toContain(
      '<div class="toy">{&quot;command&quot;:&quot;echo hi&quot;} Idle <p>Its markdown.</p></div>',
    )
    expect(shown).not.toContain(">Run<")
    expect(shown).toContain('<p class="block-status">Ready</p>')
  })
})

describe("the window asking the engine for a block", () => {
  const asking = async (answer: unknown, request: ViewRequest) => {
    const main = fakeMain((tag) =>
      tag === "GetSession" || tag === "GetBlock" ? undefined : answer,
    )
    const said = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makeEngineClient(main.bridge), (engine) =>
          followingOf(
            engine,
            Schema.decodeSync(SessionId)(SESSION),
            Schema.decodeUnknownSync(Settings)(SETTINGS),
          ).act(Schema.decodeSync(BlockView.fields.block)("setup"), request),
        ),
      ).pipe(Effect.timeout("2 seconds")),
    )
    return { said, asked: main.asked }
  }

  it("sends the view's request for the frame's session and block", async () => {
    const { said, asked } = await asking({ _tag: "Started", run: "r-1" }, { _tag: "RunBlock" })
    expect(asked).toEqual([{ tag: "RunBlock", payload: { session: SESSION, block: "setup" } }])
    expect(said).toBeUndefined()
  })

  it.each([
    [
      { _tag: "Refused", reason: { _tag: "AlreadyRunning" } },
      { _tag: "RunBlock" },
      "It is already running.",
    ],
    [
      { _tag: "Refused", reason: { _tag: "NeedsInput", fields: ["region"] } },
      { _tag: "RunBlock" },
      "It didn't run: it needs region.",
    ],
    [
      { _tag: "AwaitingApproval", approval: "a-1" },
      { _tag: "RunBlock" },
      "It runs once you approve it.",
    ],
    ["notRunning", { _tag: "CancelBlock" }, "It wasn't running, so nothing was cancelled."],
  ] as const)("says what the engine answered %j", async (answer, request, line) => {
    expect((await asking(answer, request)).said).toBe(line)
  })

  it("says the engine failed when the call dies, rather than saying nothing", async () => {
    const { said } = await asking(dies({ name: "Error", message: "the block's run threw" }), {
      _tag: "RunBlock",
    })
    expect(said).toBe("The engine failed: the block's run threw")
  })

  it("says what failed when the engine refuses the call", async () => {
    const main = fakeMain(() => fails({ _tag: "UnknownBlock", session: SESSION, block: "setup" }))
    const said = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makeEngineClient(main.bridge), (engine) =>
          followingOf(
            engine,
            Schema.decodeSync(SessionId)(SESSION),
            Schema.decodeUnknownSync(Settings)(SETTINGS),
          ).act(Schema.decodeSync(BlockView.fields.block)("setup"), { _tag: "ResetBlock" }),
        ),
      ).pipe(Effect.timeout("2 seconds")),
    )
    expect(said).toBe("The engine has no block setup in this runbook's session.")
  })
})

describe("a block's frame, following the engine", () => {
  it("moves from Ready to Running to Done as the engine's events say, offering what each takes", async () => {
    let greet: Record<string, unknown> = {
      block: "greet",
      tag: "Example",
      class: "task",
      status: { _tag: "Idle" },
      actions: ["run"],
      outputs: {},
    }
    const main = fakeMain((tag) =>
      tag === "GetSession"
        ? {
            session: SESSION,
            name: "deploy",
            path: RUNBOOK,
            sequence: 2,
            trust: { trusted: true, hash: `sha256:${"0".repeat(64)}` },
            blocks: [greet],
            warnings: [],
          }
        : tag === "GetBlock"
          ? greet
          : undefined,
    )
    const shownAfter = (live: Live) => {
      const store = makeLiveStore()
      store.set(live)
      return page(
        {
          live: store,
          settings: makeSettingsStore(undefined),
          trusting: makeTrustingStore(),
          act: () => Effect.never,
          trust: () => Effect.void,
        },
        placed({ id: "greet" }),
      )
    }
    const seen: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineClient(main.bridge)
          const shown = yield* Queue.unbounded<Live>()
          yield* Effect.forkScoped(
            follow(engine, Schema.decodeSync(SessionId)(SESSION), (live) =>
              Queue.offerUnsafe(shown, live),
            ),
          )
          seen.push(shownAfter(yield* Queue.take(shown)))
          greet = { ...greet, status: { _tag: "Running" }, actions: ["cancel", "reset"] }
          main.stream("Events", [
            {
              session: SESSION,
              sequence: 3,
              at: "2026-11-26T12:00:00.000Z",
              event: { _tag: "BlockStatusChanged", block: "greet", status: { _tag: "Running" } },
            },
          ])
          seen.push(shownAfter(yield* Queue.take(shown)))
          greet = {
            ...greet,
            status: { _tag: "Done", outcome: "success" },
            actions: ["run", "reset"],
          }
          main.stream("Events", [
            {
              session: SESSION,
              sequence: 4,
              at: "2026-11-26T12:00:01.000Z",
              event: {
                _tag: "BlockStatusChanged",
                block: "greet",
                status: { _tag: "Done", outcome: "success" },
              },
            },
          ])
          seen.push(shownAfter(yield* Queue.take(shown)))
        }),
      ).pipe(Effect.timeout("2 seconds")),
    )
    const [ready, running, done] = seen
    expect(ready).toContain('<p class="block-status">Ready</p>')
    expect(ready).toContain(">Run</button>")
    expect(running).toContain('<p class="block-status">Running</p>')
    expect(running).toContain(">Cancel</button>")
    expect(done).toContain('<p class="block-status">Done</p>')
    expect(done).toContain('aria-label="Step: done"')
  })
})

/** `following`, with instruction mode `on`. */
const inInstructionMode = (following: Following, on = true): Following => ({
  ...following,
  settings: makeSettingsStore(
    Schema.decodeUnknownSync(Settings)({ ...SETTINGS, instructionMode: on }),
  ),
})

const DEPLOY = [
  { kind: "text", markdown: "Run this command:" },
  { kind: "code", language: "bash", code: "tofu apply" },
]

describe("instruction mode", () => {
  it("shows a task's instruction in place of its view, each command to copy, and offers no Run", () => {
    const shown = page(
      inInstructionMode(
        followingViews(view("deploy", { _tag: "Idle" }, { actions: ["run"], instruction: DEPLOY })),
      ),
      placed({ id: "deploy" }),
    )
    expect(shown).toContain("<p>Run this command:</p>")
    expect(shown).toContain(
      '<pre class="block-command"><code class="language-bash">tofu apply</code></pre>',
    )
    expect(shown).not.toContain(">Run</button>")
    expect(shown).not.toContain("block-status")
  })

  it("shows the view as usual when it is off", () => {
    const shown = page(
      inInstructionMode(
        followingViews(view("deploy", { _tag: "Idle" }, { actions: ["run"], instruction: DEPLOY })),
        false,
      ),
      placed({ id: "deploy" }),
    )
    expect(shown).toContain(">Run</button>")
    expect(shown).not.toContain("tofu apply")
  })

  it("shows a credential block's instruction, its links as links, and a form as it is", () => {
    const shown = page(
      inInstructionMode(
        followingViews(
          view(
            "cloud",
            { _tag: "Idle" },
            {
              class: "credential",
              instruction: [
                { kind: "text", markdown: "Sign in to the account you use." },
                { kind: "link", label: "The cloud's console", url: "https://console.example.com/" },
                { kind: "link", label: "A local file", url: "file:///etc/passwd" },
              ],
            },
          ),
          view("config", { _tag: "Idle" }, { class: "form" }),
        ),
      ),
      placed({ id: "cloud", class: "credential" }),
      placed({ id: "config", class: "form" }),
    )
    expect(shown).toContain("<p>Sign in to the account you use.</p>")
    expect(shown).toContain('<a href="https://console.example.com/">The cloud&#x27;s console</a>')
    expect(shown).toContain("A local file (file:///etc/passwd)")
    expect(shown).not.toContain("this sign-in yet")
    expect(shown).toContain("The window can&#x27;t show this form&#x27;s fields yet.")
  })

  it("runs nothing, even when a view asks as it draws", () => {
    const asked: string[] = []
    const Asks: View<Schema.Json> = ({ act }) => {
      act({ _tag: "RunBlock" })
      return <p>A view that asks.</p>
    }
    const following = (on: boolean): Following => ({
      ...inInstructionMode(
        followingViews(view("deploy", { _tag: "Idle" }, { actions: ["run"], instruction: DEPLOY })),
        on,
      ),
      act: (block, request) => {
        asked.push(`${request._tag} ${block}`)
        return Effect.never
      },
    })
    const drawn = (on: boolean, block: DocumentBlock) =>
      renderToStaticMarkup(
        <ViewsContext value={{ Example: Asks }}>
          <FollowingContext value={following(on)}>
            <Markdown
              document={{
                tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
                blocks: [block],
              }}
              runbook={RUNBOOK}
              session={SESSION}
            />
          </FollowingContext>
        </ViewsContext>,
      )
    expect(drawn(true, placed({ id: "deploy", props: {} }))).not.toContain("A view that asks.")
    expect(
      drawn(true, placed({ id: "deploy", class: "display", step: false, props: {} })),
    ).toContain("A view that asks.")
    expect(asked).toEqual([])
    drawn(false, placed({ id: "deploy", props: {} }))
    expect(asked).toEqual(["RunBlock deploy"])
  })

  it("takes a form's values, which its instruction reads, while it runs nothing", () => {
    const asked: string[] = []
    const Enters: View<Schema.Json> = ({ act }) => {
      act({ _tag: "SetValues", values: { region: "us-east-1" } })
      act({ _tag: "ResetBlock" })
      return <p>A form.</p>
    }
    renderToStaticMarkup(
      <ViewsContext value={{ Example: Enters }}>
        <FollowingContext
          value={{
            ...inInstructionMode(
              followingViews(view("deploy", { _tag: "Idle" }, { class: "form", actions: [] })),
            ),
            act: (block, request) => {
              asked.push(`${request._tag} ${block}`)
              return Effect.never
            },
          }}
        >
          <Markdown
            document={{
              tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
              blocks: [placed({ id: "deploy", class: "form", step: true, props: {} })],
            }}
            runbook={RUNBOOK}
            session={SESSION}
          />
        </FollowingContext>
      </ViewsContext>,
    )
    expect(asked).toEqual(["SetValues deploy"])
  })

  it("sends no Cancel and no credential action a view asks for", () => {
    const asked: string[] = []
    const Asks: View<Schema.Json> = ({ act }) => {
      act({ _tag: "CancelBlock" })
      act({ _tag: "ActOnCredential", action: { _tag: "Confirm" } })
      return <p>A view that asks.</p>
    }
    // A display block's view draws in instruction mode, so it asks then too.
    const drawn = (on: boolean) =>
      renderToStaticMarkup(
        <ViewsContext value={{ Example: Asks }}>
          <FollowingContext
            value={{
              ...inInstructionMode(followingViews(), on),
              act: (block, request) => {
                asked.push(`${request._tag} ${block}`)
                return Effect.never
              },
            }}
          >
            <Markdown
              document={{
                tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
                blocks: [placed({ id: "deploy", class: "display", step: false, props: {} })],
              }}
              runbook={RUNBOOK}
              session={SESSION}
            />
          </FollowingContext>
        </ViewsContext>,
      )
    expect(drawn(true)).toContain("A view that asks.")
    expect(asked).toEqual([])
    drawn(false)
    expect(asked).toEqual(["CancelBlock deploy", "ActOnCredential deploy"])
  })

  it("keeps following the session when watching the settings fails", async () => {
    let deploy: Record<string, unknown> = {
      block: "deploy",
      tag: "Example",
      class: "task",
      status: { _tag: "Idle" },
      actions: ["run"],
      outputs: {},
      instruction: DEPLOY,
    }
    const main = fakeMain((tag) =>
      tag === "GetSession"
        ? {
            session: SESSION,
            name: "deploy",
            path: RUNBOOK,
            sequence: 2,
            trust: { trusted: true, hash: `sha256:${"0".repeat(64)}` },
            blocks: [deploy],
            warnings: [],
          }
        : tag === "GetBlock"
          ? deploy
          : undefined,
    )
    const statuses: Array<string | undefined> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineClient(main.bridge)
          const following = followingOf(
            engine,
            Schema.decodeSync(SessionId)(SESSION),
            Schema.decodeUnknownSync(Settings)(SETTINGS),
          )
          const changes = yield* Queue.unbounded<void>()
          following.live.subscribe(() => Queue.offerUnsafe(changes, undefined))
          yield* Effect.acquireRelease(Effect.sync(following.start), (stop) => Effect.sync(stop))
          yield* Queue.take(changes)
          const statusNow = () => following.live.get().blocks.get("deploy")?.status?._tag
          statuses.push(statusNow())
          main.end("WatchSettings", dies({ name: "Error", message: "the settings file vanished" }))
          // The watch's defect arrives before the run starts.
          yield* Effect.sleep("50 millis")
          deploy = { ...deploy, status: { _tag: "Running" }, actions: ["cancel"] }
          main.stream("Events", [
            {
              session: SESSION,
              sequence: 3,
              at: "2026-11-26T12:00:00.000Z",
              event: { _tag: "BlockStatusChanged", block: "deploy", status: { _tag: "Running" } },
            },
          ])
          yield* Queue.take(changes)
          statuses.push(statusNow())
          expect(following.live.get().ended).toBeUndefined()
          expect(following.settings.get()?.instructionMode).toBe(false)
        }),
      ).pipe(Effect.timeout("2 seconds")),
    )
    expect(statuses).toEqual(["Idle", "Running"])
  })

  it("shows a change of the setting as the engine streams it, without a reload", async () => {
    const deploy = {
      block: "deploy",
      tag: "Example",
      class: "task",
      status: { _tag: "Idle" },
      actions: ["run"],
      outputs: {},
      instruction: DEPLOY,
    }
    const main = fakeMain((tag) =>
      tag === "GetSession"
        ? {
            session: SESSION,
            name: "deploy",
            path: RUNBOOK,
            trust: { trusted: true, hash: `sha256:${"0".repeat(64)}` },
            blocks: [deploy],
            warnings: [],
          }
        : tag === "GetBlock"
          ? deploy
          : undefined,
    )
    const shown: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngineClient(main.bridge)
          const following = followingOf(
            engine,
            Schema.decodeSync(SessionId)(SESSION),
            Schema.decodeUnknownSync(Settings)(SETTINGS),
          )
          const changes = yield* Queue.unbounded<void>()
          following.live.subscribe(() => Queue.offerUnsafe(changes, undefined))
          following.settings.subscribe(() => Queue.offerUnsafe(changes, undefined))
          yield* Effect.acquireRelease(Effect.sync(following.start), (stop) => Effect.sync(stop))
          yield* Queue.take(changes)
          shown.push(page(following, placed({ id: "deploy" })))
          main.stream("WatchSettings", [
            {
              settings: { ...SETTINGS, instructionMode: true },
              file: "/data/settings.json",
              problems: [],
            },
          ])
          yield* Queue.take(changes)
          shown.push(page(following, placed({ id: "deploy" })))
          main.stream("WatchSettings", [
            { settings: SETTINGS, file: "/data/settings.json", problems: [] },
          ])
          yield* Queue.take(changes)
          shown.push(page(following, placed({ id: "deploy" })))
        }),
      ).pipe(Effect.timeout("2 seconds")),
    )
    const [off, on, offAgain] = shown
    expect(off).toContain(">Run</button>")
    expect(on).toContain('<code class="language-bash">tofu apply</code>')
    expect(on).not.toContain(">Run</button>")
    expect(offAgain).toContain(">Run</button>")
  })
})
