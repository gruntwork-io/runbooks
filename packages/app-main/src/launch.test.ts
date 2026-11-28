import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import type { WatchMode } from "@runbooks/core/protocol"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { findLaunchRunbook, launchArgument, watchModeOf } from "./launch.ts"

describe("launchArgument", () => {
  const cases: Array<[string, ReadonlyArray<string>, boolean, string | undefined]> = [
    ["a packaged app's first argument", ["/Applications/Runbooks", "./rb"], false, "./rb"],
    [
      "the argument after an unpackaged run's entry",
      ["electron", "app-out/main/index.js", "./rb"],
      true,
      "./rb",
    ],
    [
      "the argument among switches, as Playwright launches the app",
      [
        "electron",
        "--inspect=0",
        "--remote-debugging-port=0",
        "app-out/main/index.js",
        "--user-data-dir=/tmp/x",
        "/abs/rb",
      ],
      true,
      "/abs/rb",
    ],
    ["the first of two", ["Runbooks", "one", "two"], false, "one"],
    ["nothing past macOS's process serial number", ["Runbooks", "-psn_0_12345"], false, undefined],
    [
      "nothing past an unpackaged run's entry",
      ["electron", "app-out/main/index.js"],
      true,
      undefined,
    ],
    ["nothing with no arguments", ["Runbooks"], false, undefined],
  ]
  it.each(cases)("takes %s", (_name, argv, defaultApp, expected) => {
    expect(launchArgument(argv, defaultApp)).toBe(expected)
  })
})

describe("watchModeOf", () => {
  const cases: Array<[string, ReadonlyArray<string>, WatchMode]> = [
    ["notice with no flags", ["Runbooks", "./rb"], "notice"],
    ["runbookAndFiles for --watch", ["Runbooks", "--watch", "./rb"], "runbookAndFiles"],
    [
      "runbook for --watch --disable-live-file-reload",
      ["Runbooks", "--watch", "--disable-live-file-reload", "./rb"],
      "runbook",
    ],
    [
      "runbook for the two the other way round, after the runbook",
      ["Runbooks", "./rb", "--disable-live-file-reload", "--watch"],
      "runbook",
    ],
    [
      "notice for --disable-live-file-reload alone, as the old app's watched script files",
      ["Runbooks", "--disable-live-file-reload", "./rb"],
      "notice",
    ],
    [
      "runbookAndFiles among switches, as Playwright launches the app",
      [
        "electron",
        "--inspect=0",
        "--remote-debugging-port=0",
        "app-out/main/index.js",
        "--user-data-dir=/tmp/x",
        "--watch",
        "/abs/rb",
      ],
      "runbookAndFiles",
    ],
    ["runbookAndFiles for --watch twice", ["Runbooks", "--watch", "--watch"], "runbookAndFiles"],
    [
      "notice for a switch that only starts as --watch does, which is not one of the app's",
      ["Runbooks", "--watch=true", "--watcher", "./rb"],
      "notice",
    ],
    ["notice with no arguments", ["Runbooks"], "notice"],
  ]
  it.each(cases)("gives %s", (_name, argv, expected) => {
    expect(watchModeOf(argv)).toBe(expected)
  })
})

describe("findLaunchRunbook", () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-launch-")))
    mkdirSync(path.join(folder, "with"))
    writeFileSync(path.join(folder, "with", "runbook.mdx"), "# A runbook\n")
    mkdirSync(path.join(folder, "without"))
    writeFileSync(path.join(folder, "other.mdx"), "# Another\n")
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const find = (argument: string, startedIn: string | undefined) =>
    Effect.runPromise(
      findLaunchRunbook(argument, startedIn).pipe(
        Effect.result,
        Effect.provide(NodeFileSystemLive),
      ),
    )

  it("names a file it is given, relative to the folder the app was started in", async () => {
    expect(await find("other.mdx", folder)).toEqual(Result.succeed(path.join(folder, "other.mdx")))
  })

  it("names the runbook.mdx in a folder it is given", async () => {
    expect(await find(path.join(folder, "with"), "/")).toEqual(
      Result.succeed(path.join(folder, "with", "runbook.mdx")),
    )
  })

  it("finds nothing in a folder with no runbook.mdx", async () => {
    expect(await find("without", folder)).toEqual(
      Result.fail({ _tag: "NoRunbookInFolder", folder: path.join(folder, "without") }),
    )
  })

  it("finds nothing at a path that does not exist", async () => {
    expect(await find("gone", folder)).toEqual(
      Result.fail({ _tag: "Missing", path: path.join(folder, "gone") }),
    )
  })

  it("finds nothing at a relative path when the folder it was started in can't be read", async () => {
    expect(await find("with", undefined)).toEqual(
      Result.fail({ _tag: "UnknownFolder", argument: "with" }),
    )
    expect(await find(path.join(folder, "with"), undefined)).toEqual(
      Result.succeed(path.join(folder, "with", "runbook.mdx")),
    )
  })
})
