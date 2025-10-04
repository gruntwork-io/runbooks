---
title: Write Your First Runbook
sidebar:
   order: 2
---

Let's create a simple runbook from scratch!

## Create the Runbook File

Create a new file called `my-first-runbook.mdx`:

```mdx
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
\```
</BoilerplateInputs>

## Create Your Greeting

<Command 
    id="create-greeting"
    command='echo "Hello {{ .Name }}! Your favorite language is {{ .FavoriteLanguage }}." > greeting.txt'
    boilerplateInputsId="user-info"
    title="Create greeting file"
    description="This will create a file called greeting.txt with your personalized greeting"
    successMessage="Greeting file created! Check greeting.txt"
    failMessage="Failed to create greeting file"
/>

## Verify the File

<Check 
    id="verify-file" 
    command="cat greeting.txt"
    title="Verify the greeting file"
    description="Let's make sure the file was created correctly"
    successMessage="File looks good!"
    failMessage="Something went wrong with the file"
/>

## Next Steps

Congratulations! You've completed your first runbook. 

Try modifying this runbook to:
- Add more checks
- Collect different user inputs
- Run different commands
- Generate files using Boilerplate templates
```

## Open Your Runbook

Save the file and open it with Runbooks:

```bash
runbooks open my-first-runbook.mdx
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

### `<Check>` Block
Runs a command and shows success/failure based on the exit code:
- Exit code 0 = success ✓
- Exit code 1 = failure ✗
- Exit code 2 = warning ⚠

### `<BoilerplateInputs>` Block
Creates a web form based on the YAML variable definitions. Supports:
- `string` - text input
- `int` - number input
- `bool` - checkbox
- `enum` - dropdown select
- `list` - dynamic list of values
- `map` - key-value pairs

### `<Command>` Block
Executes a shell command with variable substitution using Go templates. Link it to a BoilerplateInputs block using `boilerplateInputsId`.

## Next: Advanced Features

Ready to learn more? Check out:
- [Boilerplate Templates](/authoring/blocks/boilerplateinputs) - Generate multiple files from templates
- [Check Scripts](/authoring/blocks/check) - Run shell scripts for more complex validations
- [Command Scripts](/authoring/blocks/command) - Execute shell scripts with parameters
