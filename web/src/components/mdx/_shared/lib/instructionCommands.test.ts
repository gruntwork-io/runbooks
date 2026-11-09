import { describe, it, expect } from "vitest"
import {
  buildGitCloneCommand,
  buildGhPrCommand,
  buildGlabMrCommand,
  buildBoilerplateInvocation,
  buildOpItemCreateCommand,
} from "./instructionCommands"

describe("buildGitCloneCommand", () => {
  it("builds a minimal clone", () => {
    expect(buildGitCloneCommand({ url: "https://github.com/org/repo.git" })).toBe(
      "git clone 'https://github.com/org/repo.git'",
    )
  })

  it("includes --branch and a destination when provided", () => {
    expect(
      buildGitCloneCommand({
        url: "https://github.com/org/repo.git",
        ref: "main",
        localPath: "repo",
      }),
    ).toBe("git clone --branch 'main' 'https://github.com/org/repo.git' 'repo'")
  })

  it("falls back to a placeholder when the url is empty", () => {
    expect(buildGitCloneCommand({ url: "" })).toBe("git clone <repository-url>")
  })
})

describe("buildGhPrCommand", () => {
  it("builds title + body + labels", () => {
    const cmd = buildGhPrCommand({
      title: "My PR",
      body: "Some changes",
      labels: ["enhancement", "infra"],
    })
    expect(cmd).toContain("gh pr create")
    expect(cmd).toContain("--title 'My PR'")
    expect(cmd).toContain("--body 'Some changes'")
    expect(cmd).toContain("--label 'enhancement'")
    expect(cmd).toContain("--label 'infra'")
  })

  it("escapes embedded single quotes", () => {
    const cmd = buildGhPrCommand({ title: "it's done" })
    expect(cmd).toContain("--title 'it'\\''s done'")
  })
})

describe("buildGlabMrCommand", () => {
  it("builds title + description (NOT --body) + labels", () => {
    const cmd = buildGlabMrCommand({
      title: "My MR",
      description: "Some changes",
      labels: ["enhancement", "infra"],
    })
    expect(cmd).toContain("glab mr create")
    expect(cmd).toContain("--title 'My MR'")
    expect(cmd).toContain("--description 'Some changes'")
    expect(cmd).not.toContain("--body")
    expect(cmd).toContain("--label 'enhancement'")
    expect(cmd).toContain("--label 'infra'")
  })

  it("escapes embedded single quotes", () => {
    const cmd = buildGlabMrCommand({ title: "it's done" })
    expect(cmd).toContain("--title 'it'\\''s done'")
  })
})

describe("buildBoilerplateInvocation", () => {
  it("emits one --var per non-empty variable and JSON-encodes objects", () => {
    const cmd = buildBoilerplateInvocation({
      path: "templates/vpc",
      variables: { region: "us-east-1", empty: "", tags: { team: "infra" } },
    })
    expect(cmd).toContain("--template-url 'templates/vpc'")
    expect(cmd).toContain("--non-interactive")
    // Matches the folder the Generate button writes to (next to the runbook).
    expect(cmd).toContain("--output-folder './generated'")
    expect(cmd).toContain("--var 'region=us-east-1'")
    expect(cmd).toContain('--var \'tags={"team":"infra"}\'')
    expect(cmd).not.toContain("empty=")
  })

  it("uses a repo-directory placeholder for the worktree target", () => {
    const cmd = buildBoilerplateInvocation({
      path: "templates/vpc",
      variables: {},
      target: "worktree",
    })
    expect(cmd).toContain("--output-folder '<repo-directory>'")
  })
})

describe("buildOpItemCreateCommand", () => {
  it("writes each field as an assignment statement", () => {
    expect(
      buildOpItemCreateCommand({
        vault: "Ops",
        title: "AWS prod",
        username: "terraform",
        password: "pw",
        url: "https://aws.amazon.com",
        tags: ["aws", "prod"],
        fields: [
          { label: "access key id", value: "AKIA", type: "text" },
          { label: "secret.key", value: "s3cr3t" },
        ],
      }),
    ).toBe(
      [
        "op item create",
        "--vault 'Ops'",
        "--category 'Login'",
        "--title 'AWS prod'",
        "--url 'https://aws.amazon.com'",
        "--tags 'aws,prod'",
        "'username=terraform'",
        "'password=pw'",
        "'access key id[text]=AKIA'",
        "'secret\\.key[password]=s3cr3t'",
      ].join(" \\\n  "),
    )
  })

  it("puts an API Credential's password in its credential field", () => {
    expect(
      buildOpItemCreateCommand({
        vault: "v",
        title: "t",
        category: "API Credential",
        password: "p",
      }),
    ).toContain("'credential=p'")
  })
})
