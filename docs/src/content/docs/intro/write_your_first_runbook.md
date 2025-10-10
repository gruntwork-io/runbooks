---
title: Write Your First Runbook
sidebar:
   order: 3
---

Let's create a simple runbook from scratch!

## Create the Runbook File

1. Create a new folder called `my-first-runbook`.
1. Inside that folder, create a new file `runbook.mdx`.
1. Copy/paste the following content into `runbook.mdx`:

`````mdx
# My First Runbook

Welcome to your first runbook! This is a simple example that demonstrates the key features.

## What This Runbook Does

This runbook will:
1. Check if Git is installed on your system
2. Ask you for your name
3. Create a personalized greeting file

## Prerequisites

<Admonition type="info" title="Prerequisites" description="Make sure you have Git installed on your system." />

<Check
    id="check-git"
    command="git --version"
    title="Check if Git is installed"
    description="We need Git for version control"
    successMessage="Git is installed!"
    failMessage="Git is not installed. Please install it from https://git-scm.com/"
/>

## Tell Us About Yourself

<BoilerplateInputs id="user-info">
```yaml
variables:
  - name: Name
    type: string
    description: What's your name?
    validations: "required"
  - name: FavoriteLanguage
    type: enum
    description: What's your favorite programming language?
    options:
      - Go
      - Python
      - JavaScript
      - Rust
      - Other
    default: Go
```
</BoilerplateInputs>

## Create Your Greeting

<Command 
    id="create-greeting"
    command='echo "Hello {{ .Name }}! Your favorite language is {{ .FavoriteLanguage }}."'
    boilerplateInputsId="user-info"
    title="Say a greeting"
    description="This will create a file called greeting.txt with your personalized greeting"
    successMessage="Greeting file created!"
    failMessage="Failed to issue greeting"
/>

## Next Steps

Congratulations! You've completed your first runbook.

Try modifying this runbook to:
- Add more checks
- Collect different user inputs
- Run different commands
- Generate files using Boilerplate templates
`````

## Open Your Runbook

Save the file and open it with Runbooks:

```bash
runbooks open my-first-runbook/runbook.mdx
```

Your browser will open showing the runbook interface. Follow the steps to execute each block!

## Understanding the Structure

Let's break down what we just created:

### Markdown Content
Regular markdown works as expected - headers, paragraphs, lists, code blocks, etc.

### `<Admonition>` Block
Creates a callout box to highlight important information:
```mdx
<Admonition type="info" title="Title" description="Description" />
```

Types: `info`, `warning`, `danger`, `success`

Learn more about [Admonition blocks](/authoring/blocks/admonition).

### `<Check>` Block
Runs a command and shows success/failure based on the exit code:
- Exit code 0 = success ✓
- Exit code 1 = failure ✗
- Exit code 2 = warning ⚠

Learn more about [Check blocks](/authoring/blocks/check).

### `<BoilerplateInputs>` Block
Creates a web form based on [Boilerplate](https://github.com/gruntwork-io) YAML variable definitions.

In this case, we passed the Boilerplate variables file as inline value by directly including it in the Runbook. You could also reference an existing `boilerplate.yml` file by using the `path` property (e.g. `<BoilerplateInputs path="templates/boilerplate.yml" />`).

Eithe rway, the `boilerplate.yml` file supports several different variable types, including:

- `string` - text input
- `int` - number input
- `bool` - checkbox
- `enum` - dropdown select
- `list` - dynamic list of values
- `map` - key-value pairs

Try adding a new variable and refreshing the browser. You'll see the Runbok form automatically update!

Learn more about [BoilerplateInputs blocks](/authoring/blocks/boilerplateinputs).

### `<Command>` Block
Executes a shell command with variable substitution using Go templates. Link it to a `<BoilerplateInputs>` block using `boilerplateInputsId`.

Learn more about [Command blocks](/authoring/blocks/command).

## Next

If you've already installed `runbooks`, you'll see what the Runbook above looks like for end users. But if you're just browsing for now, let's show you what the end-user experience for the above Runbook looks like.
