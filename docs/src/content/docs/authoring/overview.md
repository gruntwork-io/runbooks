---
title: Overview
sidebar:
   order: 1
---

# Authoring Runbooks

Runbooks are written in **MDX** (Markdown with JSX), which means you can use all standard markdown features plus special React components (blocks) for interactive functionality.

## File Format

Runbooks must be named `runbook.mdx` and use the MDX file format. The file contains:

1. **Standard Markdown** - Headers, paragraphs, lists, code blocks, images, links, etc.
2. **Special Blocks** - React components like `<Check>`, `<Command>`, `<BoilerplateInputs>`, etc.

## Basic Structure

Here's a typical runbook structure:

```mdx
# Runbook Title

Introduction paragraph explaining what this runbook does.

## Prerequisites

<Check 
    id="check-prereq" 
    command="tool --version"
    title="Check if required tool is installed"
    successMessage="Tool is installed!"
    failMessage="Please install the tool first"
/>

## Configuration

<BoilerplateInputs id="config">
```yaml
variables:
  - name: ProjectName
    type: string
    description: Name for your project
\```
</BoilerplateInputs>

## Actions

<Command 
    id="do-something"
    command="echo {{ .ProjectName }}"
    boilerplateInputsId="config"
    title="Execute action"
    successMessage="Done!"
/>

## Next Steps

Instructions for what to do next...
```

## Available Blocks

### `<Check>`
Validates prerequisites and system state by running shell commands or scripts. Exit codes determine success/failure/warning.

### `<Command>`
Executes shell commands with variable substitution using Go template syntax.

### `<BoilerplateInputs>`
Creates dynamic web forms based on Boilerplate variable definitions. Can be standalone or embedded in Commands.

### `<BoilerplateTemplate>`
Renders Boilerplate templates inline without writing to disk (advanced use case).

### `<Admonition>`
Creates callout boxes to highlight important information (info, warning, danger, success).

## File Organization

A typical runbook directory structure:

```
my-runbook/
├── runbook.mdx              # Main runbook file
├── checks/                   # Shell scripts for validation
│   ├── prereq1.sh
│   └── prereq2.sh
├── scripts/                  # Shell scripts for commands
│   ├── deploy.sh
│   └── cleanup.sh
├── templates/                # Boilerplate templates
│   ├── boilerplate.yml
│   ├── main.tf
│   └── variables.tf
└── assets/                   # Images and other assets
    └── diagram.png
```

## Best Practices

### 1. Start with Prerequisites
Always begin with `<Check>` blocks to validate the user's environment.

### 2. Collect Inputs Early
Use `<BoilerplateInputs>` blocks near the top to collect all necessary information before executing commands.

### 3. Provide Clear Messages
Write descriptive success/failure messages that guide users on what to do next.

### 4. Test Your Runbook
Run through your runbook yourself to ensure all commands work and paths are correct.

### 5. Use Relative Paths
Reference scripts and templates using paths relative to the runbook file:
```mdx
<Check path="checks/my-check.sh" ... />
<BoilerplateInputs templatePath="templates/my-template" ... />
```

### 6. Document Variable Usage
When using variables in commands, make it clear which `BoilerplateInputs` block provides them:
```mdx
<Command 
    command="echo {{ .VarName }}"
    boilerplateInputsId="my-inputs"
    ...
/>
```

## Variable Substitution

Commands support Go template syntax for variable substitution:

- `{{ .VarName }}` - Insert a variable value
- `{{ .VarName | upper }}` - Transform to uppercase
- `{{ .VarName | lower }}` - Transform to lowercase
- `{{ if .VarName }}...{{ end }}` - Conditional logic

Variables come from `<BoilerplateInputs>` blocks linked via `boilerplateInputsId`.

## Next Steps

- Learn about [Markdown syntax](/authoring/markdown)
- Explore [individual blocks](/authoring/blocks/)
- Understand the [development workflow](/authoring/workflow)
