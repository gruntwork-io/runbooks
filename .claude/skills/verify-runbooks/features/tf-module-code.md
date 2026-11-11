# The Code tab

A `<TfApplyWithGitHubPullRequest>` block's Code tab shows the code the runbook's template (the `<TfModule>` block's `template` prop) renders with the inputs as they are now: a Terragrunt unit in the demo. With a repository (a `<GitClone>` block, or the simulated one in simulation mode) it shows the unit in its folder there, among the files above it, compared with the base branch.

## Sub-features

- Facts above the code: Repository, Compared with (base branch), Module (name linked to its folder on GitHub, with its ref), and a State warning when the repository has no root.hcl above the unit.
- File tree: folders first, all open; `A` marks a new file, `M` a changed one; context files (the `.hcl` files in folders above the unit) are dimmed.
- A changed file opens as its diff, with a Changes / Whole file toggle; unchanged and context files say so under the code.
- A count of inputs that need a fix, when there are any.
- Without a repository: the unit beside a root.hcl Runbooks writes, and "none: add a GitClone block".
- A plain OpenTofu template (one with no terragrunt.hcl): the code shows without a root.hcl, opens on its main.tf, and Apply runs `tofu init`, `plan` and `apply`.
- A missing or wrong `template` prop: the block, or the Code tab, says what to set.

## How to get to it (user POV)

Fill the form and press Generate; the `apply-group` block opens on its Code tab.

## Driving it with control-runbooks

1. `$C setup group-code`, then `$C click tab:Code --within apply-group`.
2. `$C snapshot --within apply-group`. Check: Repository acme/infrastructure-live, Compared with main, Module google-group linked with v0.14.0; tree google-groups > platform@example.com > terragrunt.hcl marked new, org.hcl and root.hcl dimmed.
3. `$C screenshot code-tab --within apply-group`. Read it as the user: is it clear what's new and where it goes?
4. `$C click treeitem:root.hcl --within apply-group`. Check: the note says it's already on main and shown for context.
5. Changed file: `$C setup scenario group-exists`, back to Code. Check: terragrunt.hcl marked M and shown as a diff (old ref, Platform, bo@ removed); `$C click button:"Whole file" --within apply-group` shows it whole.
6. Inputs change follows: `$C fill Security --label Name --exact --within group`, back to Code. Check: the diff shows the new name.

7. Plain OpenTofu: copy the demo runbook to a scratch folder, add a `templates/google-group-tofu/` with a `main.tf` that calls the module with `{{ .ModuleSource | toJson }}` and a `boilerplate.yml`, point `template` at it, and `$C up` that copy. Check: the Code tab shows `main.tf` and no root.hcl, and the State warning doesn't show.

Proof: the PR tab's "What files will be committed?" lists exactly the files the tree marks A or M.

Automated tests: `__tests__/CodeTab.test.tsx`, `src/domain/tf-module/unit.test.ts` (placing the unit, statuses), `src/domain/tf-module/moduleSource.test.ts`, `src/domain/tf-module/repoFiles.test.ts`.

## Gotchas

- The code renders 300ms after the inputs settle; read it after a short wait.
- The unit's folder comes from the block's `path` prop over the published inputs, so it includes the email suffix (`platform@example.com`).
