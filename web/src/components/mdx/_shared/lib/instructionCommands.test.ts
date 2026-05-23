import { describe, it, expect } from 'vitest'
import {
  buildGitCloneCommand,
  buildGhPrCommand,
  buildBoilerplateInvocation,
} from './instructionCommands'

describe('buildGitCloneCommand', () => {
  it('builds a minimal clone', () => {
    expect(buildGitCloneCommand({ url: 'https://github.com/org/repo.git' })).toBe(
      "git clone 'https://github.com/org/repo.git'",
    )
  })

  it('includes --branch and a destination when provided', () => {
    expect(
      buildGitCloneCommand({
        url: 'https://github.com/org/repo.git',
        ref: 'main',
        localPath: 'repo',
      }),
    ).toBe("git clone --branch 'main' 'https://github.com/org/repo.git' 'repo'")
  })

  it('falls back to a placeholder when the url is empty', () => {
    expect(buildGitCloneCommand({ url: '' })).toBe('git clone <repository-url>')
  })
})

describe('buildGhPrCommand', () => {
  it('builds title + body + labels', () => {
    const cmd = buildGhPrCommand({
      title: 'My PR',
      body: 'Some changes',
      labels: ['enhancement', 'infra'],
    })
    expect(cmd).toContain("gh pr create")
    expect(cmd).toContain("--title 'My PR'")
    expect(cmd).toContain("--body 'Some changes'")
    expect(cmd).toContain("--label 'enhancement'")
    expect(cmd).toContain("--label 'infra'")
  })

  it('escapes embedded single quotes', () => {
    const cmd = buildGhPrCommand({ title: "it's done" })
    expect(cmd).toContain("--title 'it'\\''s done'")
  })
})

describe('buildBoilerplateInvocation', () => {
  it('emits one --var per non-empty variable and JSON-encodes objects', () => {
    const cmd = buildBoilerplateInvocation({
      path: 'templates/vpc',
      variables: { region: 'us-east-1', empty: '', tags: { team: 'infra' } },
    })
    expect(cmd).toContain("--template-url 'templates/vpc'")
    expect(cmd).toContain("--non-interactive")
    expect(cmd).toContain("--var 'region=us-east-1'")
    expect(cmd).toContain('--var \'tags={"team":"infra"}\'')
    expect(cmd).not.toContain('empty=')
  })

  it('uses a repo-directory placeholder for the worktree target', () => {
    const cmd = buildBoilerplateInvocation({
      path: 'templates/vpc',
      variables: {},
      target: 'worktree',
    })
    expect(cmd).toContain("--output-folder '<repo-directory>'")
  })
})
