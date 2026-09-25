import { describe, it, expect } from "bun:test"
import { protectedEnvVarsForRunbook } from "./protected-env.ts"

describe("protectedEnvVarsForRunbook", () => {
  it("returns the AWS credential vars when the runbook has an <AwsAuth> block", () => {
    const mdx = [
      "# Deploy",
      "",
      '<AwsAuth id="aws-auth" />',
      "",
      '<Command id="deploy" command="terraform apply" />',
    ].join("\n")
    expect(protectedEnvVarsForRunbook(mdx)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ])
  })

  it("returns none when <AwsAuth> only appears inside a fenced code block", () => {
    const mdx = [
      "# Using AwsAuth",
      "",
      "```mdx",
      '<AwsAuth id="aws-auth" />',
      "```",
      "",
      '<Command id="list" command="ls" />',
    ].join("\n")
    expect(protectedEnvVarsForRunbook(mdx)).toEqual([])
  })

  it("returns none when the runbook has no <AwsAuth> block", () => {
    const mdx = '# Hello\n\n<Command id="hello" command="echo hi" />\n'
    expect(protectedEnvVarsForRunbook(mdx)).toEqual([])
  })
})
