---
title: Overview
sidebar:
   order: 5
---

# Blocks Overview

Blocks are special React components that you can use in your MDX runbooks to add interactive functionality. They're written like HTML/JSX tags within your markdown.

## Available Blocks

### `<Check>`
Validates prerequisites and system state by running shell commands or scripts.

- **Purpose**: Ensure required tools are installed, verify system configuration, validate infrastructure state
- **Exit Codes**: 0 = success ✓, 1 = failure ✗, 2 = warning ⚠
- **Use Case**: Pre-flight checks, validation steps, smoke tests

[Learn more about `<Check>`](/authoring/blocks/check)

### `<Command>`
Executes shell commands or scripts with variable substitution.

- **Purpose**: Run deployment scripts, execute CLI commands, perform operations
- **Variables**: Supports Go template syntax for variable interpolation
- **Use Case**: Deployments, resource creation, configuration changes

[Learn more about `<Command>`](/authoring/blocks/command)

### `<BoilerplateInputs>`
Creates dynamic web forms based on Boilerplate variable definitions.

- **Purpose**: Collect user input, configure templates, gather parameters
- **Types**: string, int, bool, enum, list, map
- **Use Case**: Configuration collection, parameter input, template customization

[Learn more about `<BoilerplateInputs>`](/authoring/blocks/boilerplateinputs)

### `<BoilerplateTemplate>`
Renders Boilerplate templates inline without writing to disk (advanced).

- **Purpose**: Preview generated files, inline template rendering
- **Use Case**: Showing users what will be generated, debugging templates

[Learn more about `<BoilerplateTemplate>`](/authoring/blocks/boilerplatetemplate)

### `<Admonition>`
Creates callout boxes to highlight important information.

- **Types**: note, info, warning, danger
- **Purpose**: Draw attention to important notes, warnings, or tips
- **Use Case**: Highlighting prerequisites, warnings, important notes

[Learn more about `<Admonition>`](/authoring/blocks/admonition)

## Common Patterns

### Sequential Checks and Commands

```mdx
<Check id="check-prereq" command="terraform --version" ... />
<BoilerplateInputs id="config" templatePath="templates/vpc" />
<Command id="deploy" path="scripts/deploy.sh" boilerplateInputsId="config" ... />
<Check id="verify" command="terraform state list" ... />
```

### Inline BoilerplateInputs

Instead of referencing a separate BoilerplateInputs block, you can embed one directly:

```mdx
<Command id="create-repo" command="gh repo create {{ .RepoName }}">
    <BoilerplateInputs id="inline-inputs">
    ```yaml
    variables:
      - name: RepoName
        type: string
    \```
    </BoilerplateInputs>
</Command>
```

### Skippable Steps

All Check and Command blocks have a "Skip" checkbox, allowing users to skip optional steps.

## Block Properties

### Required Props

Most blocks require:
- `id` - Unique identifier for the block

### Optional Common Props

- `title` - Display title for the block
- `description` - Longer description of what the block does
- `successMessage` - Message shown on successful execution
- `failMessage` - Message shown on failure

## Variable Substitution

Blocks that execute commands support Go template syntax:

```mdx
<Command 
    command="echo {{ .VarName }}"
    boilerplateInputsId="my-inputs"
/>
```

Variables are provided by linked BoilerplateInputs blocks using the `boilerplateInputsId` prop.

## Best Practices

1. **Always provide unique IDs** - Each block needs a unique `id` prop
2. **Use descriptive titles** - Help users understand what each block does
3. **Provide helpful messages** - Write clear success/failure messages
4. **Link inputs properly** - Use `boilerplateInputsId` to connect Commands/Checks to their inputs
5. **Test your blocks** - Run through your runbook to ensure all blocks work correctly
