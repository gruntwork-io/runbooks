import { describe, it, expect } from "bun:test"
import { gitCloneArgs } from "./clone-args.ts"

describe("gitCloneArgs", () => {
  it("ends option parsing before the URL and destination", () => {
    expect(gitCloneArgs("https://github.com/o/r.git", "/work/r")).toEqual([
      "clone",
      "--progress",
      "--",
      "https://github.com/o/r.git",
      "/work/r",
    ])
  })

  it("passes the ref as the value of --branch, before --", () => {
    expect(gitCloneArgs("git@github.com:o/r.git", "/work/r", { ref: "v1.2.3" })).toEqual([
      "clone",
      "--progress",
      "--branch",
      "v1.2.3",
      "--",
      "git@github.com:o/r.git",
      "/work/r",
    ])
  })

  it("clones blobless without a checkout for a sparse checkout", () => {
    expect(gitCloneArgs("https://github.com/o/r.git", "/work/r", { sparse: true })).toEqual([
      "clone",
      "--progress",
      "--filter=blob:none",
      "--no-checkout",
      "--",
      "https://github.com/o/r.git",
      "/work/r",
    ])
  })
})

// Real git: an option-like URL or ref must never run the command it smuggles.
