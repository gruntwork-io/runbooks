import { describe, it, expect } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { createOnePasswordItem, itemTemplate, onePasswordItemRequestError } from "./item.ts"
import type { OnePasswordItemRequest } from "./item.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import type { OutputLine } from "../../services/ProcessSpawner.ts"
import { SpawnError } from "../../errors/index.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"

const REQUEST: OnePasswordItemRequest = {
  vault: "Infrastructure",
  title: "AWS prod IAM user",
  category: "Login",
  username: "terraform",
  password: "console-pass",
  url: "https://123456789012.signin.aws.amazon.com/console",
  tags: ["aws", "prod"],
  fields: [
    { label: "access key id", value: "AKIAEXAMPLE", type: "text" },
    { label: "secret access key", value: "s3cr3t" },
  ],
}

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

/** Answers `op item list` and `op item create`, recording argv and stdin. */
function fakeOp(replies: { list?: Reply; create?: Reply } | "ENOENT") {
  const calls: Array<{ args: string[]; stdin?: string | undefined }> = []
  const spawner = Layer.succeed(ProcessSpawner, {
    spawn: (command, args, options) =>
      Effect.suspend(() => {
        calls.push({ args, stdin: options?.stdin })
        if (replies === "ENOENT") {
          return Effect.fail(
            new SpawnError({
              command,
              cause: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
            }),
          )
        }
        const reply = (args[1] === "list" ? replies.list : replies.create) ?? {}
        const lines: OutputLine[] = [
          ...(reply.stdout ? [{ line: reply.stdout, source: "stdout" as const }] : []),
          ...(reply.stderr ? [{ line: reply.stderr, source: "stderr" as const }] : []),
        ]
        return Effect.succeed({
          output: Stream.fromIterable(lines),
          exitCode: Effect.succeed(reply.exitCode ?? 0),
          kill: Effect.void,
        })
      }),
  })
  return { calls, layer: Layer.merge(spawner, makeTestEnvironment({})) }
}

const CREATED = JSON.stringify({
  id: "abc123",
  title: "AWS prod IAM user",
  vault: { id: "v1", name: "Infrastructure" },
})

describe("onePasswordItemRequestError", () => {
  it("accepts a complete request", () => {
    expect(onePasswordItemRequestError(REQUEST)).toBe(undefined)
  })

  it("requires a vault and a title", () => {
    expect(onePasswordItemRequestError({ title: "x" })).toContain("vault")
    expect(onePasswordItemRequestError({ vault: "x" })).toContain("itemTitle")
  })

  it("rejects an unknown category and field type", () => {
    expect(onePasswordItemRequestError({ vault: "v", title: "t", category: "Wallet" })).toContain(
      "Wallet",
    )
    expect(
      onePasswordItemRequestError({
        vault: "v",
        title: "t",
        fields: [{ label: "a", value: "b", type: "secret" }],
      }),
    ).toContain('type "secret"')
  })

  it("requires every field to have a label", () => {
    expect(
      onePasswordItemRequestError({ vault: "v", title: "t", fields: [{ label: "", value: "b" }] }),
    ).toContain("Field 1 needs a label")
  })
})

describe("itemTemplate", () => {
  it("files a Login's username and password where 1Password fills them from", () => {
    expect(itemTemplate(REQUEST)).toEqual({
      title: "AWS prod IAM user",
      category: "LOGIN",
      fields: [
        {
          id: "username",
          type: "STRING",
          label: "username",
          value: "terraform",
          purpose: "USERNAME",
        },
        {
          id: "password",
          type: "CONCEALED",
          label: "password",
          value: "console-pass",
          purpose: "PASSWORD",
        },
        { id: "access_key_id", type: "STRING", label: "access key id", value: "AKIAEXAMPLE" },
        { id: "secret_access_key", type: "CONCEALED", label: "secret access key", value: "s3cr3t" },
      ],
    })
  })

  it("puts an API Credential's password in its credential field", () => {
    const template = itemTemplate({
      vault: "v",
      title: "t",
      category: "API Credential",
      password: "p",
    })
    expect(template.fields).toEqual([
      { id: "credential", type: "CONCEALED", label: "credential", value: "p" },
    ])
  })

  it("keeps field ids unique", () => {
    const template = itemTemplate({
      vault: "v",
      title: "t",
      category: "Secure Note",
      notes: "hello",
      fields: [
        { label: "Key!", value: "1" },
        { label: "key", value: "2" },
      ],
    })
    expect((template.fields as Array<{ id: string }>).map((field) => field.id)).toEqual([
      "notesPlain",
      "key",
      "key_2",
    ])
  })
})

describe("createOnePasswordItem", () => {
  it("passes secrets on stdin, never as arguments", async () => {
    const { calls, layer } = fakeOp({ list: { stdout: "[]" }, create: { stdout: CREATED } })
    const result = await Effect.runPromise(
      createOnePasswordItem(REQUEST).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      itemId: "abc123",
      title: "AWS prod IAM user",
      vaultId: "v1",
      vaultName: "Infrastructure",
    })
    expect(calls[0]!.args).toEqual([
      "item",
      "list",
      "--vault",
      "Infrastructure",
      "--format",
      "json",
    ])
    expect(calls[1]!.args).toEqual([
      "item",
      "create",
      "--vault",
      "Infrastructure",
      "--format",
      "json",
      "--url",
      "https://123456789012.signin.aws.amazon.com/console",
      "--tags",
      "aws,prod",
      "-",
    ])
    const argv = calls.flatMap((call) => call.args).join(" ")
    expect(argv).not.toContain("s3cr3t")
    expect(argv).not.toContain("console-pass")
    expect(JSON.parse(calls[1]!.stdin!)).toEqual(itemTemplate(REQUEST))
  })

  it("names the account when one is given", async () => {
    const { calls, layer } = fakeOp({ list: { stdout: "[]" }, create: { stdout: CREATED } })
    await Effect.runPromise(
      createOnePasswordItem({ ...REQUEST, account: "my.1password.com" }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(calls[1]!.args.slice(-3)).toEqual(["--account", "my.1password.com", "-"])
  })

  it("refuses to add a second item with the same title", async () => {
    const { calls, layer } = fakeOp({
      list: { stdout: JSON.stringify([{ id: "old", title: "AWS prod IAM user" }]) },
    })
    const exit = await Effect.runPromiseExit(
      createOnePasswordItem(REQUEST).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("already has an item named")
    expect(calls).toHaveLength(1)
  })

  it("says how to sign in when op isn't signed in", async () => {
    const { layer } = fakeOp({
      list: {
        stderr: "[ERROR] 2026/11/09 12:00:00 account is not signed in",
        exitCode: 1,
      },
    })
    const exit = await Effect.runPromiseExit(
      createOnePasswordItem(REQUEST).pipe(Effect.provide(layer)),
    )
    const text = JSON.stringify(exit)
    expect(text).toContain("account is not signed in")
    expect(text).toContain("Integrate with 1Password CLI")
    expect(text).not.toContain("[ERROR]")
  })

  it("keeps secrets out of op's error output", async () => {
    const { layer } = fakeOp({
      list: { stdout: "[]" },
      create: { stderr: "[ERROR] 2026/11/09 12:00:00 bad field value s3cr3t", exitCode: 1 },
    })
    const exit = await Effect.runPromiseExit(
      createOnePasswordItem(REQUEST).pipe(Effect.provide(layer)),
    )
    expect(JSON.stringify(exit)).not.toContain("s3cr3t")
    expect(JSON.stringify(exit)).toContain("<redacted>")
  })

  it("says how to install op when it's missing", async () => {
    const { layer } = fakeOp("ENOENT")
    const exit = await Effect.runPromiseExit(
      createOnePasswordItem(REQUEST).pipe(Effect.provide(layer)),
    )
    expect(JSON.stringify(exit)).toContain("isn't installed")
  })

  it("fails before running op when the request is invalid", async () => {
    const { calls, layer } = fakeOp({})
    const exit = await Effect.runPromiseExit(
      createOnePasswordItem({ ...REQUEST, vault: " " }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})
