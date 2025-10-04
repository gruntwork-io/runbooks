---
title: Tour
sidebar:
  order: 2
---

Let's see Runbooks in action!

## Opening a Runbook

To open a runbook, use the `open` command:

```bash
runbooks open /path/to/runbook.mdx
```

This will:
1. Start the backend API server on port 7825
2. Launch your default browser with the runbook interface
3. Parse and render the markdown content with interactive components

## Runbook Structure

A runbook is typically a `.mdx` file (Markdown with JSX) that can contain:

### Standard Markdown
- Headers, paragraphs, lists
- Code blocks with syntax highlighting
- Images and links
- Bold, italic, and other text formatting

### Interactive Blocks

#### `<Check>` - System Validation
Runs a shell script to verify system prerequisites:

```mdx
<Check 
    id="check-terraform" 
    path="checks/terraform-installed.sh" 
    title="Check if Terraform is installed"
    description="We need Terraform to deploy infrastructure"
    successMessage="Terraform is installed!"
    failMessage="Terraform is not installed. Please install it first."
/>
```

#### `<Command>` - Execute Shell Commands
Runs shell commands with variable substitution:

```mdx
<Command 
    id="create-repo"
    command="gh repo create {{ .OrgName }}/{{ .RepoName }} --private"
    title="Create GitHub Repository"
    successMessage="Repository created!"
    failMessage="Failed to create repository"
>
    <BoilerplateInputs id="repo-inputs">
    ```yaml
    variables:
    - name: OrgName
      type: string
      description: Your GitHub organization name
    - name: RepoName
      type: string
      description: Name for the new repository
    ```
    </BoilerplateInputs>
</Command>
```

#### `<BoilerplateInputs>` - Dynamic Forms
Creates a web form based on Boilerplate variable definitions:

```mdx
<BoilerplateInputs id="my-form" templatePath="templates/my-template" />
```

The form renders based on the `boilerplate.yml` file in the template directory, supporting various input types: string, int, bool, list, map, and enum.

#### `<Admonition>` - Callout Boxes
Highlight important information:

```mdx
<Admonition type="warning" title="Important" description="Make sure to backup your data first!" />
```

## Example Runbook Flow

Here's a typical runbook workflow:

1. **Introduction** - Standard markdown explaining what the runbook does
2. **Pre-flight Checks** - `<Check>` blocks to verify prerequisites
3. **Configuration** - `<BoilerplateInputs>` blocks to collect user input
4. **Actions** - `<Command>` blocks to execute operations
5. **Validation** - More `<Check>` blocks to verify success
6. **Next Steps** - Guide users to what comes next

## Try a Demo Runbook

The repository includes several demo runbooks in the `testdata/` directory:

```bash
runbooks open testdata/demo-runbook-1/runbook.mdx
```

This will walk you through a realistic example of creating infrastructure repositories.
