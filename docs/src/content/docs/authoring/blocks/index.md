---
title: Overview
sidebar:
   order: 5
---

Blocks are the interactive components of a `runbook.mdx` file. Write them as JSX tags within your markdown.

## Available blocks

These are all the blocks a runbook can use. A component that isn't listed here, such as `<Tabs>`, fails to render.

### Collect input and generate files

- [`<Inputs>`](/authoring/blocks/inputs) renders a form whose values other blocks use in their scripts, templates and props.
- [`<Template>`](/authoring/blocks/template) generates files from a Boilerplate template directory, with a form for the template's variables.
- [`<TemplateInline>`](/authoring/blocks/templateinline) renders a Boilerplate template written in the runbook itself and shows the result inline.
- [`<DirPicker>`](/authoring/blocks/dirpicker) selects a directory path with a cascading set of dropdowns.

### Run scripts

- [`<Command>`](/authoring/blocks/command) runs a shell command or script that changes state, such as a deployment.
- [`<Check>`](/authoring/blocks/check) runs a shell command or script that reports whether the user's system is in the expected state.
- [`<Prerequisites>`](/authoring/blocks/prerequisites) checks that the tools the runbook needs are installed, at the versions it needs, and says how to install the ones that aren't.
- [`<Finish>`](/authoring/blocks/finish) marks the end of the runbook. It can run a final check, then shows your next steps.

### Authenticate

- [`<AwsAuth>`](/authoring/blocks/awsauth) signs in to AWS with static credentials, AWS SSO, or a local AWS profile.
- [`<GoogleAuth>`](/authoring/blocks/googleauth) signs in to Google Cloud with a service account key, a Google sign-in, or a gcloud configuration.
- [`<GitAuth>`](/authoring/blocks/gitauth) signs in to GitHub or GitLab, chosen from a dropdown.
- [`<GitHubAuth>`](/authoring/blocks/githubauth) is `<GitAuth>` locked to GitHub.
- [`<GitLabAuth>`](/authoring/blocks/gitlabauth) is `<GitAuth>` locked to GitLab.

### Work with git repositories

- [`<GitClone>`](/authoring/blocks/gitclone) clones a git repository, or uses a checkout the user already has on disk.
- [`<GitPullRequest>`](/authoring/blocks/gitpullrequest) commits the changes in a cloned repository and opens a GitHub pull request or a GitLab merge request.
- [`<GitHubPullRequest>`](/authoring/blocks/githubpullrequest) is `<GitPullRequest>` locked to GitHub.
- [`<GitLabMergeRequest>`](/authoring/blocks/gitlabmergerequest) is `<GitPullRequest>` locked to GitLab.

### Show content

- [`<Admonition>`](/authoring/blocks/admonition) renders a note, info, warning, or danger callout.
- [`<Iframe>`](/authoring/blocks/iframe) embeds a web page: an external site, or an HTML page from the runbook's `assets/` folder.

## Block IDs

Interactive blocks take an `id` prop, a unique identifier for the block. When one block references another, it does so by the other block's ID:

- `inputsId` uses the values collected by an `<Inputs>` or `<Template>` block. See [Wiring blocks with `inputsId`](/authoring/inputs-and-outputs/#wiring-blocks-with-inputsid).
- `awsAuthId`, `googleAuthId`, `gitAuthId` and `githubAuthId` choose which auth block's credentials a block uses.
- `dependsOn` names the `<Command>` or `<Check>` blocks that must succeed before a `<Command>`, `<Check>` or `<Finish>` can run. A `<Check>` that ends with a warning counts too. See [Run order](/authoring/blocks/command/#run-order).
- `gitCloneId` roots a `<DirPicker>` in the repository a `<GitClone>` block cloned.
- `{{ .outputs.<block_id>.<output_name> }}` reads the outputs of a block that has already run. In template syntax, write any hyphens in the ID as underscores. See [Block outputs](/authoring/inputs-and-outputs/#block-outputs).

Each ID must be unique within a runbook. IDs that differ only in hyphens versus underscores (such as `create-account` and `create_account`) count as the same ID.

Runbook tests use IDs too: each step in `runbook_test.yml` names the block it runs by its ID. See [Testing](/authoring/testing/#block-ids).

In Runbooks, most blocks show a small **ID** badge in their top-right corner. `<TemplateInline>` doesn't, and neither does an `<Inputs>` block nested inside another block. Hover over the badge (or Tab to it) to see the block's ID, and click it to copy the ID to your clipboard.

## Progress

The title bar shows how far through the runbook the user is: a bar along its bottom edge fills in, and a count next to the session name, such as "2 of 5 steps done", says how many steps are done. A window narrower than 1024 pixels shows only the bar.

Each block the user acts on is a step. It is done once the block shows it's done, and stops being done if the block goes back:

| Block | Done when |
|-------|-----------|
| `<Command>` | Its last run succeeded. |
| `<Check>` | Its last run succeeded, or ended with a warning, which also lets the blocks that depend on it run. |
| `<Prerequisites>` | Its last check found every required tool. A missing optional tool doesn't matter. |
| `<Finish>` | The runbook is finished. A final check that ends with a warning leaves it unfinished. |
| `<Inputs>` | Its form was submitted, and is green. |
| `<Template>` | Its files were generated, and its form is green. |
| `<AwsAuth>`, `<GoogleAuth>`, `<GitAuth>`, `<GitHubAuth>` and `<GitLabAuth>` | It is signed in, and green: credentials that expire within five minutes turn it red. |
| `<GitClone>` | It cloned or found its repository, which is still on the session's branch. |
| `<GitPullRequest>`, `<GitHubPullRequest>` and `<GitLabMergeRequest>` | It opened its pull or merge request. |
| `<DirPicker>` | It has a path. |

`<TemplateInline>`, `<Admonition>` and `<Iframe>` aren't steps, as there is nothing in them for the user to do. Neither is an `<Inputs>` nested in a `<Command>` or `<Check>`, which is part of that block, nor a block that shows a configuration error, such as a duplicate ID, in its place.

A [resumed session](/commands/sessions/#resuming-a-session) brings the blocks back as the user left them, so their steps are done as they were. In [instruction mode](/intro/instruction-mode/#tracking-your-progress), a step is done once the user marks it as done.
