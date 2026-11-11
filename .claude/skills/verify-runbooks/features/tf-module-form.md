# Filling a TfModule block's form

A `<TfModule>` block is a form drawn from an OpenTofu module, whose Generate button writes the code that uses the module: `variables.tf` gives each input's name, type, default and validation, and the module's `runbook_block.yml` gives labels, order, option descriptions, lookups that suggest values, and shortcuts. In the demo runbook, the `group` block creates a Google group.

## Sub-features

- A dropdown filled by a lookup: Organization lists the domains from `google.domains`.
- Suggestions as you type: Owners, Members, and Managers suggest people from `google.people`, and take typed addresses too.
- A shortcut: `Add "Sam Rivera" as an owner` adds the signed-in person (`google.me`).
- A suffix: Group email shows `@<domain>` after the field, and the published value includes it.
- Validation: errors show once a field is left, or on Generate; Generate with errors writes nothing, says how many inputs need a fix, and opens Advanced options when one of them is there.
- Generate: lists the files it wrote (in simulation, the files it would write), and writes them again as the inputs change.
- Advanced options: inputs runbook_block.yml doesn't mark `primary`, folded away.
- A lookup that fails (scenario `no-directory-access`).

## How to get to it (user POV)

Open the runbook (`runbooks open --simulate testdata/feature-demos/tf-module`), trust it, and scroll to "Describe the group". The `apply-group` block below it waits until Generate.

## Driving it with control-runbooks

1. `$C up testdata/feature-demos/tf-module --simulate`, `$C setup trust`.
2. `$C snapshot --within group`. Check: no tabs; Organization, Group email, Name, Description, Owners, Members; Advanced options (3).
3. `$C click button:Generate --within group`. Check: nothing generated; errors under the required fields; a line saying how many inputs need a fix.
4. `$C type example --label Organization --within group`, then `$C snapshot --within group`. Check: options example.com (primary) and example.org.
5. `$C click option:example.com --within group`. Check: Group email now shows `@example.com` after it.
6. `$C fill platform --label "Group email" --within group`, `$C fill "Platform team" --label Name --exact --within group`.
7. `$C type ana --label Members --within group`. Check: Ana Lima suggested with her address. `$C click option:"Ana Lima" --within group`. Check: a chip ana@example.com.
8. `$C click button:"as an owner" --within group`. Check: a chip sam@example.com under Owners.
9. `$C click button:Generate --within group`. Check: the block lists google-groups/platform@example.com/terragrunt.hcl, and `apply-group` shows the unit's path and Plan.
10. Failing lookup: `$C setup scenario no-directory-access`, `$C type bo --label Members --within group`. Check: the error says what's wrong and that a typed value still works; `$C press Enter` adds bo as a chip.

Proof: the published values reach other blocks. Scroll to "Use the values" and run the Command (`$C click button:Run --within show-group`); its output shows the group email, name, and domain you entered.

Automated tests: `web/src/components/mdx/TfModule/__tests__/TfModule.test.tsx` (form, errors, publishing), `src/domain/tf-module/load.test.ts` (runbook_block.yml), `src/domain/lookups/run.test.ts` (lookup answers).

## Gotchas

- Organization's options open only after typing or pressing ArrowDown/Enter in the empty field; focus alone doesn't open them.
- Suggestions are debounced (about 200ms plus the scenario's `delayMs`); use `type`, not `fill`, so they react, and `wait` for the option before clicking it.
- A label like Name also matches "Group name"-style labels; pass `--exact`.
