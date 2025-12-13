---
title: Runbook Structure
---

# Runbook Structure

This page explains the file format and folder organization for a runbook.

## File Format

A runbook lives in its own folder and must contain a file named `runbook.mdx`. This file is written in **MDX** (Markdown + JSX), which lets you combine:

- **Standard Markdown** — Headers, paragraphs, lists, code blocks, images, links
- **Runbook Blocks** — Interactive components like `<Check>`, `<Command>`, `<Inputs>`, and `<Template>`

You can learn more about:

- [Supported markdown elements](/authoring/markdown)
- [Available blocks](/authoring/blocks)

### Common structure

While you can organize your `runbook.mdx` file however you like, here's a common pattern:

`````mdx
# Runbook Title

Introduction paragraph explaining what this runbook does.

## Pre-flight Checks

Make sure the user is set up for success.

<Check 
    id="pre-flight-checks" 
    command="tool --version"
    title="Check if required tool is installed"
    successMessage="Tool is installed!"
    failMessage="Please install the tool first"
/>

## Execute Actions

Run commands on behalf of the user to complete the runbook.

<Command 
    id="do-something"
    command="echo {{ .ProjectName }}"
    inputsId="config"
    title="Execute action"
    successMessage="Done!"
/>

## Generate Code

Generate code the user needs to accomplish their task.

<Template 
    id="infra-code"
    path="templates/infra"
/>

## Post-flight Checks

Verify everything worked.

<Check 
    id="post-flight-checks" 
    command="curl https://some-endpoint.com"
    title="Check if deployment is successful"
    successMessage="Deployment successful"
    failMessage="Something went wrong"
/>
`````

## Folder organization

Blocks often reference scripts and templates stored in folders. While you can store these anywhere, here's the conventional folder structure:

```
my-runbook/
├── runbook.mdx              # Main runbook file
├── assets/                  # Images and other assets
│   └── diagram.png
├── checks/                  # Shell scripts for <Check> blocks
│   ├── prereq1.sh
│   └── prereq2.sh
├── scripts/                 # Shell scripts for <Command> blocks
│   ├── deploy.sh
│   └── cleanup.sh
└── templates/               # Boilerplate templates for <Template> blocks
    └── my-template/
        ├── boilerplate.yml
        ├── main.tf
        └── variables.tf
```

### Folder Purposes

| Folder | Purpose | Used By |
|--------|---------|---------|
| `assets/` | Images, diagrams, and other static files | Markdown image syntax |
| `checks/` | Shell scripts that validate prerequisites | `<Check>` blocks |
| `scripts/` | Shell scripts that execute actions | `<Command>` blocks |
| `templates/` | Boilerplate template directories | `<Template>` blocks |

### Relative Paths

Always reference files relative to your runbook:

```mdx
<Check path="checks/prereq.sh" ... />
<Template path="templates/my-template" ... />
![Diagram](./assets/diagram.png)
```