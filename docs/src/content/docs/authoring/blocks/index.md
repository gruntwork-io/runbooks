---
title: Overview
sidebar:
   order: 5
---

Blocks are the interactive components of a `runbook.mdx` file. Write them as JSX tags within your markdown.

## Available blocks

- [Admonition](/authoring/blocks/admonition)
- [AwsAuth](/authoring/blocks/awsauth)
- [Check](/authoring/blocks/check)
- [Command](/authoring/blocks/command)
- [DirPicker](/authoring/blocks/dirpicker)
- [GitAuth](/authoring/blocks/gitauth)
- [GitClone](/authoring/blocks/gitclone)
- [GitHubAuth](/authoring/blocks/githubauth)
- [GitHubPullRequest](/authoring/blocks/githubpullrequest)
- [GitLabAuth](/authoring/blocks/gitlabauth)
- [GitLabMergeRequest](/authoring/blocks/gitlabmergerequest)
- [GitPullRequest](/authoring/blocks/gitpullrequest)
- [GoogleAuth](/authoring/blocks/googleauth)
- [Iframe](/authoring/blocks/iframe)
- [Inputs](/authoring/blocks/inputs)
- [Template](/authoring/blocks/template)
- [TemplateInline](/authoring/blocks/templateinline)

## Block IDs

Interactive blocks take an `id` prop, a unique identifier for the block. When one block references another, it does so by the other block's ID:

- `inputsId` uses the values collected by an `<Inputs>` or `<Template>` block. See [Wiring blocks with `inputsId`](/authoring/inputs-and-outputs/#wiring-blocks-with-inputsid).
- `awsAuthId`, `googleAuthId`, `gitAuthId` and `githubAuthId` choose which auth block's credentials a block uses.
- `gitCloneId` roots a `<DirPicker>` in the repository a `<GitClone>` block cloned.
- `{{ .outputs.<block_id>.<output_name> }}` reads the outputs of a block that has already run. In template syntax, write any hyphens in the ID as underscores. See [Block outputs](/authoring/inputs-and-outputs/#block-outputs).

Each ID must be unique within a runbook. IDs that differ only in hyphens versus underscores (such as `create-account` and `create_account`) count as the same ID.

Runbook tests use IDs too: each step in `runbook_test.yml` names the block it runs by its ID. See [Testing](/authoring/testing/#block-ids).

In Runbooks, most blocks show a small **ID** badge in their top-right corner. `<TemplateInline>` doesn't, and neither does an `<Inputs>` block nested inside another block. Hover over the badge (or Tab to it) to see the block's ID, and click it to copy the ID to your clipboard.
