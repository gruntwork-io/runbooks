import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Redacted, Schema } from "effect"
import type { ViewRequest } from "@runbooks/blocks/views"
import { BlockView } from "@runbooks/core/protocol"
import { installDom } from "./testDom.ts"

// The common auth view as a person uses it: each state the engine sends,
// drawn, and the actions its buttons and fields send, in a jsdom page.
const uninstall = installDom()
afterAll(uninstall)
const { cleanup, render, screen } = await import("@testing-library/react")
const { userEvent } = await import("@testing-library/user-event")
const { AuthView } = await import("./authView.tsx")
afterEach(cleanup)

type State = NonNullable<BlockView["credential"]>

/** A state as it crosses from the engine: decoded from JSON. */
const state = (json: Record<string, unknown>): State => {
  const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(BlockView))({
    block: "aws",
    tag: "Example",
    class: "credential",
    actions: ["credential"],
    outputs: {},
    credential: json,
  }).credential
  if (decoded === undefined) throw new Error("no state")
  return decoded
}

const IDENTITY = {
  principal: "arn:aws:iam::111111111111:user/dev",
  kind: "user",
  method: "credentials",
  targets: {
    account: { id: "111111111111", name: "production" },
    role: { id: "Admin", name: "Admin" },
  },
  expiresAt: "2026-11-28T12:00:00.000Z",
  warnings: [{ message: "The region us-west-9 is not enabled." }],
}

const CREDENTIALS = {
  name: "credentials",
  label: "Static Credentials",
  fields: [
    { name: "accessKeyId", label: "Access Key ID", required: true, secret: false },
    { name: "secretAccessKey", label: "Secret Access Key", required: true, secret: true },
    { name: "defaultRegion", label: "Default Region", required: false, secret: false },
  ],
  defaults: { defaultRegion: "eu-west-1" },
}

const METHODS = [
  CREDENTIALS,
  {
    name: "profile",
    label: "Local Profile",
    fields: [
      {
        name: "profile",
        label: "Profile",
        required: true,
        secret: false,
        choices: [
          { value: "dev", label: "dev" },
          { value: "prod", label: "prod" },
        ],
      },
    ],
    defaults: {},
  },
  {
    name: "sso",
    label: "AWS SSO",
    fields: [],
    defaults: {},
    unavailable: { _tag: "CredentialError", kind: "toolMissing", message: "No browser." },
  },
]

/** The blocks on the page: `aws`, the block drawn, and `keys`, a block it may read. */
const ON_PAGE = new Set(["aws", "keys"])

/** AWS SSO as the fake AWS provider describes it, with the block's start URL. */
const SSO = {
  name: "sso",
  label: "AWS SSO",
  fields: [
    { name: "ssoStartUrl", label: "SSO Start URL", required: true, secret: false },
    { name: "ssoRegion", label: "SSO Region", required: false, secret: false },
  ],
  defaults: { ssoStartUrl: "https://my-org.awsapps.com/start" },
}

/**
 * The view of block `aws` in the state `json`, each request its buttons and
 * fields send, and `move`, which draws the next state the engine sends.
 */
const lived = (json: Record<string, unknown>) => {
  const sent: ViewRequest[] = []
  const view = (next: Record<string, unknown>) => (
    <AuthView
      state={state(next)}
      act={(request) => sent.push(request)}
      block="aws"
      onPage={ON_PAGE}
    />
  )
  const { rerender } = render(view(json))
  return { sent, move: (next: Record<string, unknown>) => rerender(view(next)) }
}

/** The view of `json`, as block `aws`, and each request its buttons and fields send. */
const drawn = (json: Record<string, unknown>) => lived(json).sent

/** What each action sent, by its tag and what it chose. */
const actions = (sent: ReadonlyArray<ViewRequest>) =>
  sent.map((request) =>
    request._tag === "ActOnCredential" && request.action._tag === "ChooseTarget"
      ? `ChooseTarget ${request.action.level} ${request.action.id}`
      : request._tag === "ActOnCredential"
        ? request.action._tag
        : request._tag,
  )

const click = async (name: string) => userEvent.setup().click(screen.getByRole("button", { name }))

describe("the common auth view", () => {
  it("asks to confirm a login it found, and shows who it is, what it selects and when it expires", async () => {
    const sent = drawn({ _tag: "Found", identity: IDENTITY, source: "env" })
    expect(
      screen.getByText("Found a login in the environment Runbooks started in. Use it?"),
    ).toBeDefined()
    const card = document.querySelector('dl[aria-label="Signed in as"]')
    expect(Array.from(card?.querySelectorAll("dt, dd") ?? [], (part) => part.textContent)).toEqual([
      "signed in as",
      "arn:aws:iam::111111111111:user/dev",
      "account",
      "production (111111111111)",
      "role",
      "Admin",
      "expires",
      "2026-11-28T12:00:00.000Z",
    ])
    expect(screen.getByText("The region us-west-9 is not enabled.")).toBeDefined()
    await click("Use this login")
    await click("Sign in another way")
    expect(actions(sent)).toEqual(["Confirm", "Decline"])
  })

  it("says where it found a login: the environment, a block's outputs, the login it had, or a source of the provider's", () => {
    const said = (source: string) => {
      drawn({ _tag: "Found", identity: IDENTITY, source })
      const line = document.querySelector(".block-status")
      const words = { text: line?.textContent, links: line?.querySelectorAll("a").length }
      cleanup()
      return words
    }
    expect(said("env")).toEqual({
      text: "Found a login in the environment Runbooks started in. Use it?",
      links: 0,
    })
    // A block on the page is a link that scrolls to it.
    expect(said("keys")).toEqual({
      text: "Found a login in the outputs of keys. Use it?",
      links: 1,
    })
    expect(said("aws")).toEqual({
      text: "Found the login this block had before. Use it?",
      links: 0,
    })
    expect(said("cli")).toEqual({ text: "Found a login in the cli source. Use it?", links: 0 })
  })

  it("draws a tab per method, the chosen one's fields with their defaults, and why one can't be used", async () => {
    drawn({ _tag: "SignedOut", methods: METHODS, defaultMethod: "profile" })
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Static Credentials",
      "Local Profile",
      "AWS SSO",
    ])
    // The block's default method is the tab it opens on.
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Local Profile")
    expect(
      Array.from(screen.getByLabelText(/^Profile/).querySelectorAll("option"), (o) => o.value),
    ).toEqual(["dev", "prod"])
    await userEvent.setup().click(screen.getByRole("tab", { name: "Static Credentials" }))
    expect(screen.getByLabelText("Default Region")).toHaveProperty("value", "eu-west-1")
    expect(screen.getByLabelText(/Secret Access Key/)).toHaveProperty("type", "password")
    await userEvent.setup().click(screen.getByRole("tab", { name: "AWS SSO" }))
    expect(screen.getByText("AWS SSO can't be used: No browser.")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull()
  })

  it("sends what the person typed, the secret as a Redacted, and keeps no secret in the page", async () => {
    const sent = drawn({ _tag: "SignedOut", methods: METHODS, defaultMethod: "credentials" })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Access Key ID/), "AKIAEXAMPLE")
    await user.type(screen.getByLabelText(/Secret Access Key/), "typed-secret-9c2e")
    await click("Sign in")
    const [request] = sent
    if (request?._tag !== "ActOnCredential" || request.action._tag !== "SignIn")
      throw new Error(`sent ${JSON.stringify(sent)}`)
    expect(request.action.method).toBe("credentials")
    expect(
      Object.fromEntries(
        Object.entries(request.action.fields).map(([name, value]) => [
          name,
          Redacted.isRedacted(value) ? Redacted.value(value) : "not redacted",
        ]),
      ),
    ).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "typed-secret-9c2e",
      defaultRegion: "eu-west-1",
    })
    expect(screen.getByLabelText(/Secret Access Key/)).toHaveProperty("value", "")
    expect(document.body.innerHTML).not.toContain("typed-secret-9c2e")
  })

  it("reads a field's default, and sends what was typed, under the field's own name, whatever the name", async () => {
    // Names an object has from its prototype: neither is a default, and each is sent as typed.
    const odd = {
      name: "odd",
      label: "Odd",
      fields: [
        { name: "constructor", label: "Constructor", required: false, secret: false },
        { name: "__proto__", label: "Proto", required: false, secret: false },
      ],
      defaults: {},
    }
    const sent = drawn({ _tag: "SignedOut", methods: [odd], defaultMethod: "odd" })
    expect(screen.getByLabelText("Constructor")).toHaveProperty("value", "")
    expect(screen.getByLabelText("Proto")).toHaveProperty("value", "")
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Constructor"), "one")
    await user.type(screen.getByLabelText("Proto"), "two")
    await click("Sign in")
    const [request] = sent
    if (request?._tag !== "ActOnCredential" || request.action._tag !== "SignIn")
      throw new Error(`sent ${JSON.stringify(sent)}`)
    const { fields } = request.action
    expect(Object.keys(fields)).toEqual(["constructor", "__proto__"])
    expect(Object.values(fields).map((value) => Redacted.value(value))).toEqual(["one", "two"])
  })

  it("leaves a field the person left blank out of the sign-in", async () => {
    const sent = drawn({ _tag: "SignedOut", methods: METHODS, defaultMethod: "credentials" })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Access Key ID/), "AKIAEXAMPLE")
    await user.type(screen.getByLabelText(/Secret Access Key/), "typed-secret-9c2e")
    await user.clear(screen.getByLabelText("Default Region"))
    await click("Sign in")
    const [request] = sent
    if (request?._tag !== "ActOnCredential" || request.action._tag !== "SignIn")
      throw new Error(`sent ${JSON.stringify(sent)}`)
    expect(Object.keys(request.action.fields)).toEqual(["accessKeyId", "secretAccessKey"])
  })

  it("offers to look again when signed out, and says why the last attempt failed", async () => {
    const sent = drawn({
      _tag: "SignedOut",
      methods: METHODS,
      lastError: { _tag: "CredentialError", kind: "accessDenied", message: "The key is wrong." },
    })
    expect(screen.getByRole("alert").textContent).toBe("Not signed in: The key is wrong.")
    // No default method: the first tab.
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Static Credentials")
    await click("Check again")
    expect(actions(sent)).toEqual(["CheckAgain"])
  })

  it("shows a sign-in's page and code while it waits, and offers Cancel", async () => {
    const sent = drawn({
      _tag: "SigningIn",
      method: "sso",
      url: "https://device.sso.example.com/",
      code: "ABCD-EFGH",
      waiting: true,
    })
    expect(screen.getByRole("link", { name: "Open the sign-in page" })).toHaveProperty(
      "href",
      "https://device.sso.example.com/",
    )
    expect(screen.getByText("ABCD-EFGH").tagName).toBe("CODE")
    expect(screen.getByText("Waiting for you to finish signing in.")).toBeDefined()
    await click("Cancel")
    expect(actions(sent)).toEqual(["Cancel"])
  })

  it("shows a sign-in page or an install page that is not a web page as text, not as a link", () => {
    drawn({ _tag: "SigningIn", method: "sso", url: "javascript:alert(1)", waiting: false })
    expect(screen.getByText("Open javascript:alert(1) in your browser.")).toBeDefined()
    expect(document.querySelectorAll("a")).toHaveLength(0)
    cleanup()

    drawn({
      _tag: "Unavailable",
      error: {
        _tag: "CredentialError",
        kind: "toolMissing",
        message: "The Azure CLI is not installed.",
        tool: { name: "az", installUrl: "javascript:alert(1)" },
      },
    })
    expect(screen.getByText("It needs az: javascript:alert(1)")).toBeDefined()
    expect(document.querySelectorAll("a")).toHaveLength(0)
  })

  it("draws a picker of the targets at one level, None at an optional one", async () => {
    const sent = drawn({
      _tag: "ChoosingTarget",
      level: { name: "role", label: "Role", chosen: "afterSignIn", optional: true },
      options: [
        { id: "Admin", name: "Admin" },
        { id: "ReadOnly", name: "Read only" },
      ],
      chosen: { account: { id: "111111111111", name: "production" } },
    })
    const picker = screen.getByRole("group", { name: "Choose the Role" })
    expect(Array.from(picker.querySelectorAll("button"), (b) => b.textContent)).toEqual([
      "Admin",
      "Read only (ReadOnly)",
      "None",
    ])
    await click("Read only (ReadOnly)")
    await click("None")
    expect(actions(sent)).toEqual(["ChooseTarget role ReadOnly", "ChooseTarget role null"])
  })

  it("says it is signed in, or expired, or what the login lacks, each with the actions it takes", async () => {
    expect(actions(drawn({ _tag: "Ready", identity: IDENTITY, source: "env" }))).toEqual([])
    expect(screen.getByText("Signed in.")).toBeDefined()
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sign out"])
    cleanup()

    drawn({ _tag: "Expired", identity: IDENTITY })
    expect(screen.getByRole("alert").textContent).toContain("The login has expired.")
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Check again",
      "Sign out",
    ])
    cleanup()

    drawn({
      _tag: "RequirementNotMet",
      unmet: [
        { kind: "scopes", scopes: ["repo", "admin"] },
        { kind: "roles", roles: [{ role: "Owner" }] },
      ],
    })
    expect(screen.getByRole("alert").textContent).toBe(
      "The login lacks what the block requires: scopes repo, admin; roles Owner.",
    )
  })

  it("says why it can't sign in, with a link to the tool it needs, and offers to look again", async () => {
    const sent = drawn({
      _tag: "Unavailable",
      error: {
        _tag: "CredentialError",
        kind: "toolMissing",
        message: "The Azure CLI is not installed.",
        tool: { name: "az", installUrl: "https://aka.ms/azcli" },
      },
    })
    expect(screen.getByRole("alert").textContent).toBe(
      "Can't sign in: The Azure CLI is not installed.",
    )
    expect(screen.getByRole("link", { name: "install az" })).toHaveProperty(
      "href",
      "https://aka.ms/azcli",
    )
    await click("Check again")
    expect(actions(sent)).toEqual(["CheckAgain"])
  })

  it("says it is looking, and draws nothing before the engine sends a state", () => {
    drawn({ _tag: "Detecting" })
    expect(screen.getByText("Looking for a login.")).toBeDefined()
    cleanup()
    const { container } = render(
      <AuthView state={undefined} act={() => {}} block="aws" onPage={ON_PAGE} />,
    )
    expect(container.innerHTML).toBe("")
  })
})

describe("the common auth view, signed out again", () => {
  const TYPED = "https://my-org.awsapps.com/strat"
  const SIGNED_OUT = {
    _tag: "SignedOut",
    methods: [CREDENTIALS, SSO],
    defaultMethod: "credentials",
  }

  /**
   * The person types a key and its secret, then picks AWS SSO, types over
   * its start URL and signs in: the engine moves the block to SigningIn.
   */
  const signIn = async () => {
    const block = lived(SIGNED_OUT)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Access Key ID/), "AKIAEXAMPLE")
    await user.type(screen.getByLabelText(/Secret Access Key/), "typed-secret-9c2e")
    await user.click(screen.getByRole("tab", { name: "AWS SSO" }))
    await user.clear(screen.getByLabelText(/SSO Start URL/))
    await user.type(screen.getByLabelText(/SSO Start URL/), TYPED)
    await click("Sign in")
    block.move({ _tag: "SigningIn", method: "sso", url: "https://device.example/", waiting: true })
    return block
  }

  /** The tab the person chose and the text they typed, in each tab, and no secret. */
  const expectKept = async () => {
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("AWS SSO")
    expect(screen.getByLabelText(/SSO Start URL/)).toHaveProperty("value", TYPED)
    await userEvent.setup().click(screen.getByRole("tab", { name: "Static Credentials" }))
    expect(screen.getByLabelText(/Access Key ID/)).toHaveProperty("value", "AKIAEXAMPLE")
    expect(screen.getByLabelText(/Secret Access Key/)).toHaveProperty("value", "")
    expect(document.body.innerHTML).not.toContain("typed-secret-9c2e")
  }

  it("keeps the tab the person chose and what they typed after a sign-in that failed", async () => {
    const block = await signIn()
    block.move({
      ...SIGNED_OUT,
      lastError: {
        _tag: "CredentialError",
        kind: "accessDenied",
        message: "The start URL is wrong.",
      },
    })
    expect(screen.getByRole("alert").textContent).toBe("Not signed in: The start URL is wrong.")
    await expectKept()
    expect(actions(block.sent)).toEqual(["SignIn"])
  })

  it("keeps them after the person cancels the sign-in", async () => {
    const block = await signIn()
    await click("Cancel")
    block.move({
      ...SIGNED_OUT,
      lastError: {
        _tag: "CredentialError",
        kind: "cancelled",
        message: "The sign-in was cancelled.",
      },
    })
    await expectKept()
    expect(actions(block.sent)).toEqual(["SignIn", "Cancel"])
  })

  it("keeps them after the login expires and the person signs out", async () => {
    const block = await signIn()
    block.move({ _tag: "Ready", identity: IDENTITY, source: "aws" })
    block.move({ _tag: "Expired", identity: IDENTITY })
    await click("Sign out")
    block.move(SIGNED_OUT)
    await expectKept()
    expect(actions(block.sent)).toEqual(["SignIn", "SignOut"])
  })

  it("opens on the block's default method when the one the person chose is no longer offered", async () => {
    const block = lived({ _tag: "SignedOut", methods: METHODS, defaultMethod: "credentials" })
    await userEvent.setup().click(screen.getByRole("tab", { name: "Local Profile" }))
    await click("Check again")
    block.move({ _tag: "Detecting" })
    block.move({ _tag: "SignedOut", methods: [CREDENTIALS, SSO], defaultMethod: "sso" })
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("AWS SSO")
  })
})
