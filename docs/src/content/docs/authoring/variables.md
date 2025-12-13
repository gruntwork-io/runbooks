---
title: Variables
---

# Variables

One of the most powerful features of Runbooks is the ability to collect input from users and pass those values to commands, checks, and templates. This page explains how to wire variables between blocks.

## How it works

1. **Collect** — Use `<Inputs>` or `<Template>` blocks to collect values from the user via a form
2. **Reference** — Other blocks reference those values using `inputsId`
3. **Substitute** — Values are inserted using [Boilerplate template syntax](/authoring/boilerplate/) like `{{ .VarName }}`

## Collection methods

There are three ways to collect variables:

### Template block

The [Template block](/authoring/blocks/template/) reads variables from a `boilerplate.yml` file and renders a form. It also generates files from templates. Other blocks can reference the collected variables via `inputsId`:

`````mdx
<!-- Template at templates/vpc with boilerplate.yml defining Environment variable -->
<Template id="infra" path="templates/vpc" />

<Command 
    inputsId="infra" 
    command="echo 'Deploying to {{ .Environment }}'"
/>
`````

Use this when you want to both collect variables AND generate files.

### Standalone Inputs block

The [Inputs block](/authoring/blocks/inputs/) collects variables without generating files. Define variables inline, then reference them from other blocks:

`````mdx
<Inputs id="config">
```yaml
variables:
  - name: ProjectName
    type: string
    description: Name for your project
```
</Inputs>

<Command 
    inputsId="config" 
    command="mkdir {{ .ProjectName }}"
/>

<Check 
    inputsId="config" 
    command="test ! -d {{ .ProjectName }}"
    title="Verify project directory doesn't exist"
/>
`````

Use this when you want to collect variables that will be used by multiple blocks, or when you don't need to generate files.

### Embedded Inputs block

You can embed an `<Inputs>` block directly inside a `<Command>` or `<Check>` block. The variables are automatically available to the parent block without needing `inputsId`:

`````mdx
<Command command="echo 'Hello, {{ .Name }}!'">
    <Inputs id="greeting">
    ```yaml
    variables:
      - name: Name
        type: string
    ```
    </Inputs>
</Command>
`````

The embedded inputs are also available to other blocks via `inputsId="greeting"`.

Use this when variables are closely tied to a single command or check.

## Referencing variables

### The `inputsId` prop

Commands, Checks, Templates, and TemplateInline blocks all support the `inputsId` prop to import variables:

```mdx
<Command inputsId="config" command="echo {{ .ProjectName }}" />
```

### Multiple sources

You can reference multiple input sources by passing an array. Variables are merged in order, with later sources overriding earlier ones:

```mdx
<Command 
    inputsId={["global-config", "local-config"]} 
    command="deploy --env {{ .Environment }} --name {{ .AppName }}"
/>
```

## Template syntax

Variables are substituted using [Boilerplate template syntax](/authoring/boilerplate/):

| Syntax | Description |
|--------|-------------|
| `{{ .VarName }}` | Insert a variable value |
| `{{ .VarName \| upper }}` | Transform to uppercase |
| `{{ .VarName \| lower }}` | Transform to lowercase |
| `{{ if .VarName }}...{{ end }}` | Conditional logic |

See the [Boilerplate Templates](/authoring/boilerplate/) page for the full syntax reference including loops, comparisons, and helper functions.

