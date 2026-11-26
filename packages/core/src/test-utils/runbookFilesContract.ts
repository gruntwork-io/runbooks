/**
 * The contract of the hash a runbook is trusted by, for the files and
 * folders its blocks name: it covers every byte and executable bit a run
 * gets, read once, and a path the loader can't take whole is `badFile` at
 * the prop that names it. The suite runs against the in-memory file system
 * (`../document/files.test.ts`) and the real one
 * (`packages/platform-node/src/integration/document/files.test.ts`), so the
 * fake can't drift from the OS.
 */
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { configErrors } from "../document/document.ts"
import { RUNBOOK_FILE_LIMITS } from "../document/files.ts"
import { loadRunbook } from "../document/load.ts"
import { FileSystem, type FileSystemShape } from "../services/FileSystem.ts"
import { recordFileSystem, type ServiceCall } from "./ServiceCalls.ts"
import { TOY_REGISTRY } from "./toyRegistry.ts"

/** A file, with its mode; a symbolic link to a path; or a folder, with its mode. */
export type TreeEntry =
  | { readonly kind: "file"; readonly content: string | Uint8Array; readonly mode?: number }
  | { readonly kind: "link"; readonly to: string }
  | { readonly kind: "folder"; readonly mode?: number }

/**
 * What to lay out, by path relative to the runbook's folder: a string is a
 * file of that text. A path may lead out of the folder with `..`, and so may
 * a link's `to`. A file's mode is 0o644 and a folder's 0o755 unless given.
 */
export type Tree = Readonly<Record<string, string | TreeEntry>>

export interface RunbookFilesSubject {
  /**
   * A file system holding `tree`, in a world of its own, and the absolute
   * path of the runbook's folder in it. A mode given is set exactly, not
   * through the umask.
   */
  readonly lay: (
    tree: Tree,
  ) => Promise<{ readonly folder: string; readonly fileSystem: FileSystemShape }>
}

/** Each entry of `tree` with its kind, a string read as a file. */
export const treeEntries = (tree: Tree): ReadonlyArray<readonly [string, TreeEntry]> =>
  Object.entries(tree).map(([at, entry]) => [
    at,
    typeof entry === "string" ? { kind: "file", content: entry } : entry,
  ])

/** What loading the runbook gave its one block. */
interface Loaded {
  /** The hash of the path the block names, when it was found. */
  readonly hash: string | undefined
  /** The texts a run of the block gets. */
  readonly texts: ReadonlyMap<string, string>
  readonly errors: ReadonlyArray<{
    readonly code: string
    readonly prop: string | undefined
    readonly message: string
  }>
  /** Every call the loader made to the file system. */
  readonly calls: ReadonlyArray<ServiceCall>
  readonly folder: string
}

/** `count` files named `f0`, `f1`, ... under `folder`, each holding its own name. */
const manyFiles = (folder: string, count: number): Tree =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${folder}/f${i}`, `f${i}`]))

/** A path `depth` folders below `folder`. */
const nested = (folder: string, depth: number): string =>
  [folder, ...Array.from({ length: depth }, (_, i) => `d${i + 1}`)].join("/")

const bytes = (...values: ReadonlyArray<number>) => Uint8Array.from(values)

export function runbookFilesContract(name: string, subject: RunbookFilesSubject): void {
  /**
   * Loads a runbook whose one block names `named`, from `tree`. `change`
   * may wrap the file system the loader gets.
   */
  const load = async (
    tree: Tree,
    named = "templates",
    change: (fs: FileSystemShape, folder: string) => FileSystemShape = (fs) => fs,
  ): Promise<Loaded> => {
    const { folder, fileSystem } = await subject.lay({
      ...tree,
      "runbook.mdx": `<Run id="a" path="${named}" />\n`,
    })
    const calls: ServiceCall[] = []
    const recorded = recordFileSystem(change(fileSystem, folder), calls)
    const result = await Effect.runPromise(
      loadRunbook(path.join(folder, "runbook.mdx"), TOY_REGISTRY, { appVersion: "0.31.0" }).pipe(
        Effect.provide(Layer.succeed(FileSystem, recorded)),
      ),
    )
    if (result._tag === "Invalid") throw new Error(result.errors.map((e) => e.message).join("\n"))
    return {
      hash: Object.entries(result.document.hash.files).find(([at]) => at === named)?.[1],
      texts: result.texts.get(0) ?? new Map(),
      errors: configErrors(result).map((e) => ({
        code: e.code,
        prop: e.location.prop,
        message: e.message,
      })),
      calls,
      folder,
    }
  }

  /** A hash and texts, for a loaded block that has to be found. */
  const found = (loaded: Loaded) => {
    expect(loaded.errors).toEqual([])
    expect(loaded.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    return { hash: loaded.hash, texts: loaded.texts }
  }

  /** The block stopped with `badFile` at its `path`, its message holding each of `parts`, and nothing of it kept. */
  const refused = (loaded: Loaded, ...parts: ReadonlyArray<string>) => {
    expect(loaded.errors.map((e) => [e.code, e.prop])).toEqual([["badFile", "path"]])
    for (const part of parts) expect(loaded.errors[0]?.message).toContain(part)
    expect(loaded.hash).toBeUndefined()
    expect(loaded.texts).toEqual(new Map())
  }

  /** The calls that read the file at `relative`, in the runbook's folder. */
  const readsOf = (loaded: Loaded, relative: string) =>
    loaded.calls.filter(
      (call) =>
        call.method.startsWith("readFile") && call.args[0] === path.join(loaded.folder, relative),
    )

  describe(`a runbook's trust hash, ${name}`, () => {
    describe("covers what a run gets", () => {
      it("a byte changed inside invalid UTF-8 changes the hash", async () => {
        const before = found(
          await load({ "templates/data.bin": { kind: "file", content: bytes(0x41, 0xff, 0x42) } }),
        )
        const after = found(
          await load({ "templates/data.bin": { kind: "file", content: bytes(0x41, 0xfe, 0x42) } }),
        )

        expect(after.hash).not.toBe(before.hash)
      })

      it("chmod +x on a file in the folder changes the hash", async () => {
        const plain = found(
          await load({ "templates/run.sh": { kind: "file", content: "echo hi\n", mode: 0o644 } }),
        )
        const executable = found(
          await load({ "templates/run.sh": { kind: "file", content: "echo hi\n", mode: 0o755 } }),
        )

        expect(executable.hash).not.toBe(plain.hash)
      })

      it("a mode change other than the executable bit keeps the hash, as a clone's umask may make one", async () => {
        const plain = found(
          await load({ "templates/main.tf": { kind: "file", content: "x\n", mode: 0o644 } }),
        )
        const groupWritable = found(
          await load({ "templates/main.tf": { kind: "file", content: "x\n", mode: 0o664 } }),
        )

        expect(groupWritable.hash).toBe(plain.hash)
      })

      it("a file that changes between reads: the run gets the bytes that were hashed", async () => {
        const tree = { "templates/main.tf": "v1\n", "templates/vars.tf": "x\n" }
        const v1 = found(await load(tree))
        const v2 = found(await load({ ...tree, "templates/main.tf": "v2, after the first read\n" }))
        // The first read of main.tf gets v1; it holds v2 after, as if written between two reads.
        const changing = (fs: FileSystemShape, folder: string): FileSystemShape => {
          const file = path.join(folder, "templates/main.tf")
          let reads = 0
          const thenChange = <A, E>(at: string, read: Effect.Effect<A, E>) =>
            at !== file
              ? read
              : read.pipe(
                  Effect.tap(() =>
                    reads++ === 0
                      ? Effect.orDie(fs.writeFile(file, "v2, after the first read\n"))
                      : Effect.void,
                  ),
                )
          return {
            ...fs,
            readFile: (at) => thenChange(at, fs.readFile(at)),
            readFileBuffer: (at) => thenChange(at, fs.readFileBuffer(at)),
            readFileUpTo: (at, max) => thenChange(at, fs.readFileUpTo(at, max)),
          }
        }

        const got = found(await load(tree, "templates", changing))

        expect([v1, v2]).toContainEqual(got)
      })

      it("is the same for the same files, whatever order they were written in", async () => {
        const one = found(
          await load({ "templates/a.tf": "1", "templates/b/c.tf": "2", "templates/b.tf": "3" }),
        )
        const other = found(
          await load({ "templates/b.tf": "3", "templates/b/c.tf": "2", "templates/a.tf": "1" }),
        )

        expect(other).toEqual(one)
      })

      it("keeps each path apart from the bytes and the paths around it", async () => {
        const hashes = await Promise.all(
          [
            { "templates/a": "bc" },
            { "templates/ab": "c" },
            { "templates/a": "", "templates/b": "" },
            // The two files above, run together without their lengths.
            { "templates/a-0:b": "" },
          ].map(async (tree) => found(await load(tree)).hash),
        )

        expect(new Set(hashes).size).toBe(hashes.length)
      })

      it("gives a run each file's text under its path, and leaves out version control folders", async () => {
        const loaded = found(
          await load({
            "templates/main.tf": 'provider "aws" {}\n',
            "templates/modules/vars.tf": "variable x {}\n",
            "templates/.git/HEAD": "ref: refs/heads/main\n",
          }),
        )
        const withoutGit = found(
          await load({
            "templates/main.tf": 'provider "aws" {}\n',
            "templates/modules/vars.tf": "variable x {}\n",
          }),
        )

        expect(loaded.texts).toEqual(
          new Map([
            ["templates/main.tf", 'provider "aws" {}\n'],
            ["templates/modules/vars.tf", "variable x {}\n"],
          ]),
        )
        expect(loaded.hash).toBe(withoutGit.hash)
      })
    })

    describe("refuses a folder it can't take whole, at the prop", () => {
      it("a file 17 folders down is refused, naming the depth limit", async () => {
        const deep = nested("templates", RUNBOOK_FILE_LIMITS.depth + 1)

        refused(
          await load({ "templates/main.tf": "x", [`${deep}/f.tf`]: "edit me" }),
          `${deep} in it is over 16 folders deep`,
        )
      })

      it("a file 16 folders down is hashed", async () => {
        const deep = nested("templates", RUNBOOK_FILE_LIMITS.depth)
        const before = found(await load({ [`${deep}/f.tf`]: "1" }))
        const after = found(await load({ [`${deep}/f.tf`]: "2" }))

        expect(after.hash).not.toBe(before.hash)
      })

      it("a 2001st file is refused, naming the file limit", async () => {
        refused(
          await load(manyFiles("templates", RUNBOOK_FILE_LIMITS.entries + 1)),
          "names templates, which holds over 2000 files and folders",
        )
      })

      it("2000 files and folders are hashed, the last edited too", async () => {
        // The files, and one folder holding one more.
        const tree = {
          ...manyFiles("templates", RUNBOOK_FILE_LIMITS.entries - 2),
          "templates/sub/z": "1",
        }
        const before = found(await load(tree))
        const after = found(await load({ ...tree, "templates/sub/z": "2" }))

        expect(before.texts.size).toBe(RUNBOOK_FILE_LIMITS.entries - 1)
        expect(after.hash).not.toBe(before.hash)
      })

      it("a file over 1 MiB is refused, named or in a folder, naming the limit", async () => {
        const big = "x".repeat(RUNBOOK_FILE_LIMITS.fileBytes + 1)

        const named = await load({ "scripts/big.sh": big }, "scripts/big.sh")
        const inFolder = await load({ "templates/big.txt": big })

        refused(named, "names scripts/big.sh, which is over 1 MiB")
        refused(inFolder, "templates/big.txt in it is over 1 MiB")
        expect([
          ...readsOf(named, "scripts/big.sh"),
          ...readsOf(inFolder, "templates/big.txt"),
        ]).toEqual([])
      })

      it("a file of 1 MiB is hashed", async () => {
        found(
          await load(
            { "scripts/full.sh": "x".repeat(RUNBOOK_FILE_LIMITS.fileBytes) },
            "scripts/full.sh",
          ),
        )
      })

      it("a folder over 8 MiB is refused, naming the limit; one of 8 MiB is hashed", async () => {
        const files = RUNBOOK_FILE_LIMITS.folderBytes / RUNBOOK_FILE_LIMITS.fileBytes
        const full: Tree = Object.fromEntries(
          Array.from({ length: files }, (_, i) => [
            `templates/f${i}`,
            "x".repeat(RUNBOOK_FILE_LIMITS.fileBytes),
          ]),
        )

        found(await load(full))
        const over = await load({ ...full, "templates/one-more": "x" })
        refused(over, "names templates, which holds over 8 MiB of files")
        expect(readsOf(over, "templates/one-more")).toEqual([])
      })

      it("a file that grows after it is measured is refused, not kept: past 1 MiB, or past 8 MiB in its folder", async () => {
        // The file at `relative` holds `content` from the first time it is measured on.
        const growing =
          (relative: string, content: string) =>
          (fs: FileSystemShape, folder: string): FileSystemShape => {
            const file = path.join(folder, relative)
            let measured = false
            return {
              ...fs,
              stat: (at) =>
                fs.stat(at).pipe(
                  Effect.tap(() => {
                    if (at !== file || measured) return Effect.void
                    measured = true
                    return Effect.orDie(fs.writeFile(file, content))
                  }),
                ),
            }
          }
        const mib = RUNBOOK_FILE_LIMITS.fileBytes
        const nearlyFull: Tree = {
          ...Object.fromEntries(
            Array.from({ length: 7 }, (_, i) => [`templates/f${i}`, "x".repeat(mib)]),
          ),
          "templates/y": "x".repeat(mib - 1),
        }

        refused(
          await load(
            { "templates/z": "x" },
            "templates",
            growing("templates/z", "x".repeat(mib + 1)),
          ),
          "templates/z in it is over 1 MiB",
        )
        refused(
          await load(
            { ...nearlyFull, "templates/z": "x" },
            "templates",
            growing("templates/z", "xx"),
          ),
          "names templates, which holds over 8 MiB of files",
        )
      })

      it("a symbolic link in the folder is refused, so rewriting its target can't keep trust", async () => {
        const tree = {
          "templates/main.tf": "x",
          "templates/shared.tf": { kind: "link", to: "common/shared.tf" },
        } as const

        for (const shared of ["v1", "v2"]) {
          refused(
            await load({ ...tree, "common/shared.tf": shared }),
            "templates/shared.tf in it is neither a file nor a folder",
          )
        }
      })

      it("a symbolic link to a file outside the runbook's folder is refused, and the file is never read", async () => {
        const loaded = await load({
          "templates/main.tf": "x",
          "templates/secret.tf": { kind: "link", to: "../outside/secret.txt" },
          "../outside/secret.txt": "s3cr3t",
        })

        refused(loaded, "templates/secret.tf in it is neither a file nor a folder")
        const outside = path.resolve(loaded.folder, "../outside")
        const touched = loaded.calls.filter((call) =>
          call.args.some((arg) => typeof arg === "string" && path.resolve(arg).startsWith(outside)),
        )
        expect(touched).toEqual([])
      })

      it("a file that can't be read is refused, never counted as empty", async () => {
        refused(
          await load({
            "templates/main.tf": "x",
            "templates/secret.tf": { kind: "file", content: "hidden", mode: 0o000 },
          }),
          "templates/secret.tf in it can't be read",
        )
        refused(
          await load(
            { "scripts/a.sh": { kind: "file", content: "echo hi\n", mode: 0o000 } },
            "scripts/a.sh",
          ),
          "names scripts/a.sh, which can't be read",
        )
      })

      it("a folder that can't be listed is refused", async () => {
        refused(
          await load({
            "templates/main.tf": "x",
            "templates/sub/inner.tf": "y",
            "templates/sub": { kind: "folder", mode: 0o000 },
          }),
          "templates/sub in it can't be read",
        )
      })
    })
  })
}
