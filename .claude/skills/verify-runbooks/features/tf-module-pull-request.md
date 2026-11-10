# The TfModule PR tab

The PR tab opens a GitHub pull request that adds the block's Terragrunt unit to the cloned repository, then pushes later input changes to its branch, edits its title and description, and merges it. In simulation mode nothing is pushed and the pull request is simulated.

## Sub-features

- Draft: title and description drafted from the inputs (runbooks.yml `pullRequest.title`), branch and commit message under Customize commit, and the files it commits.
- Open: the pull request's title and number linked, Open pill, base and head branches; Edit title and description.
- Behind: after an input change, "The inputs changed since the last push" with Git Push.
- Merge: merge method, Merge Pull Request, and Apply first.
- Merged, then the inputs change: "Merged, before the latest changes" with New pull request, which drafts a follow-up on a new branch (`-2`).
- No repository: a warning to add GitHubAuth and GitClone blocks.

## How to get to it (user POV)

Fill the form, press Next twice, or click the PR tab.

## Driving it with control-runbooks

1. `$C setup group-form`, `$C click tab:PR --within group`. Check: title "Add the platform@example.com Google group", the description's table of inputs, the files list with the unit's terragrunt.hcl (new).
2. `$C click "button:Create Pull Request" --within group`, then `$C wait "button:Merge Pull Request" --within group`. Check: #42 linked, Open, main <- runbooks/add-the-platform-example-com-google-group, Ready to merge.
3. `$C click tab:UI --within group`, change Name, back to PR. Check: "The inputs changed since the last push" and Git Push; no merge until pushed.
4. `$C click "button:Git Push" --within group`, `$C wait "button:Merge Pull Request" --within group`.
5. `$C click "button:Merge Pull Request" --within group`, `$C wait --text "Merged into" --within group`. Check: Merged pill; the next step points at Apply unless it's applied.
6. Change Name again, back to PR. Check: "Merged, before the latest changes" and New pull request. `$C click "button:New pull request" --within group`. Check: a draft that says it follows #42, with branch `...-2` under Customize commit.

Proof: the stage moves with each step: the PR tab's next-step button, the Apply tab's, and the block's progress check agree (done only when merged and applied with the inputs as they are).

Automated tests: `__tests__/prMachine.test.ts` (transitions, behind and superseded), `__tests__/flow.test.ts` (stages), `__tests__/pullRequest.test.ts` (drafts).

## Gotchas

- Without `--simulate`, Create Pull Request and Merge act on GitHub for real: dry-run them first, and only with `--real-home` and a repository you may change.
- The description field is a Markdown editor without a label; reach it with `--role textbox --name "Describe the changes..."`.
