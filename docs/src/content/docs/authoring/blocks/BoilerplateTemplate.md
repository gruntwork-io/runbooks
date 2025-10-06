---
title: <BoilerplateTemplate>
---

The `<BoilerplateTemplate>` block renders Boilerplate templates inline or allows you to specify templates inline in your runbook. Like `<BoilerplateInputs>`, it uses the Boilerplate engine to generate files, but displays the rendered file directly in the markdown.

## Overview

Both `<BoilerplateInputs>` and `<BoilerplateTemplate>` use the Boilerplate engine to generate files. The key differences are:

- **`<BoilerplateInputs>`**: Generates files and saves them to your workspace (persisted), can reference template directories
- **`<BoilerplateTemplate>`**: Generates files, displays content inline, allows inline template specification

Use `<BoilerplateTemplate>` when you want to:

- Show users a preview of what will be generated
- Display generated configuration inline
- Debug template rendering
- Generate content for display rather than file creation

## Basic Usage

`````mdx
<BoilerplateInputs id="config">
```yaml
variables:
  - name: ServiceName
    type: string
    description: Name of the service
    default: my-service
  - name: Port
    type: int
    description: Port number
    default: 8080
```
</BoilerplateInputs>

<BoilerplateTemplate boilerplateInputsId="config">
```yaml
# config.yaml
service:
  name: {{ .ServiceName }}
  port: {{ .Port }}
  enabled: true
```
</BoilerplateTemplate>
`````

## Props

### Required Props

- `boilerplateInputsId` (string) - ID of the BoilerplateInputs block to get variables from

### Optional Props

- `outputPath` (string) - Optional path prefix for the generated files in the preview
- `children` (ReactNode) - Inline template content to render

## How It Works

1. User fills out the BoilerplateInputs form
2. BoilerplateTemplate automatically uses the Boilerplate engine to generate files with the current variable values
3. Files are generated to temporary directories, read for display, then immediately cleaned up
4. Generated content is displayed in the UI with syntax highlighting
5. No files are persisted to your workspace (only shown in the UI)

## Examples

### Single File Template

```mdx
<BoilerplateInputs id="docker-config">
```yaml
variables:
  - name: AppName
    type: string
  - name: NodeVersion
    type: string
    default: "18"
\```
</BoilerplateInputs>

<BoilerplateTemplate boilerplateInputsId="docker-config">
```dockerfile
FROM node:{{ .NodeVersion }}-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
\```
</BoilerplateTemplate>
```

### Multiple Files

You can have multiple BoilerplateTemplate blocks referencing the same BoilerplateInputs:

```mdx
<BoilerplateInputs id="app-config">
```yaml
variables:
  - name: AppName
    type: string
  - name: Environment
    type: enum
    options: [dev, prod]
\```
</BoilerplateInputs>

### Application Configuration

<BoilerplateTemplate boilerplateInputsId="app-config" outputPath="config.yaml">
```yaml
app:
  name: {{ .AppName }}
  environment: {{ .Environment }}
\```
</BoilerplateTemplate>

### Environment Variables

<BoilerplateTemplate boilerplateInputsId="app-config" outputPath=".env">
```bash
APP_NAME={{ .AppName }}
ENVIRONMENT={{ .Environment }}
\```
</BoilerplateTemplate>
```

### With Boilerplate Logic

You can use full Boilerplate template syntax:

```mdx
<BoilerplateInputs id="terraform-config">
```yaml
variables:
  - name: Environment
    type: enum
    options: [dev, prod]
  - name: InstanceType
    type: string
    default: t3.micro
  - name: EnableMonitoring
    type: bool
    default: false
\```
</BoilerplateInputs>

<BoilerplateTemplate boilerplateInputsId="terraform-config">
```hcl
resource "aws_instance" "app" {
  ami           = "ami-12345678"
  instance_type = "{{ .InstanceType }}"

  tags = {
    Name        = "app-{{ .Environment }}"
    Environment = "{{ .Environment }}"
  }

  {{- if .EnableMonitoring }}
  monitoring = true
  {{- end }}
}
\```
</BoilerplateTemplate>
```

## Features

### Auto-Rendering

The template automatically re-renders whenever the user changes values in the linked BoilerplateInputs form (with debouncing for performance).

### Syntax Highlighting

Rendered content is displayed with appropriate syntax highlighting based on the file extension or language hint.

### File Tree View

When multiple BoilerplateTemplate blocks reference the same BoilerplateInputs, they're organized in a file tree view.

### Error Handling

If template rendering fails (e.g., invalid Boilerplate syntax), an error message is displayed.

## Advanced Usage

### Directory Structure

You can organize templates in a directory structure using the outputPath prop:

```mdx
<BoilerplateTemplate boilerplateInputsId="config" outputPath="terraform/main.tf">
...
</BoilerplateTemplate>

<BoilerplateTemplate boilerplateInputsId="config" outputPath="terraform/variables.tf">
...
</BoilerplateTemplate>

<BoilerplateTemplate boilerplateInputsId="config" outputPath="scripts/deploy.sh">
...
</BoilerplateTemplate>
```

### Conditional Templates

Use Boilerplate's conditional logic:

```mdx
<BoilerplateTemplate boilerplateInputsId="config">
```hcl
{{- if eq .Environment "prod" }}
# Production configuration
resource "aws_instance" "app" {
  instance_type = "t3.large"
  monitoring    = true
}
{{- else }}
# Development configuration
resource "aws_instance" "app" {
  instance_type = "t3.micro"
  monitoring    = false
}
{{- end }}
\```
</BoilerplateTemplate>
```

## When to Use

### Use BoilerplateTemplate when:
- You want to show users a preview of generated content
- You need to display configuration inline
- You're debugging templates
- You want to demonstrate what Boilerplate does

### Use BoilerplateInputs alone when:
- You need to actually generate and save files
- You want to generate multiple files from a template directory
- You're generating infrastructure-as-code that will be used by other commands

## Comparison with BoilerplateInputs

| Feature | BoilerplateInputs | BoilerplateTemplate |
|---------|------------------|---------------------|
| Uses Boilerplate engine | ✅ Yes | ✅ Yes |
| Generates files | ✅ Yes (persisted to workspace) | ✅ Yes (temporary, cleaned up) |
| Shows preview in UI | ❌ No | ✅ Yes |
| Can use with Commands | ✅ Yes | ✅ Yes (variables available) |
| File tree output | ✅ Yes (persisted) | ✅ Yes (preview only) |
| Template directory | ✅ Supports | ❌ Inline only |
| Auto-render | ✅ Yes (for Commands/Checks) | ✅ Yes |

## Best Practices

### 1. Use for Documentation

Show users what their inputs will generate:

```mdx
Fill out the form above to see your Kubernetes configuration:

<BoilerplateTemplate boilerplateInputsId="k8s-config">
...
</BoilerplateTemplate>
```

### 2. Preview Before Generation

Combine with BoilerplateInputs for a "preview then generate" workflow:

```mdx
<BoilerplateInputs id="config" templatePath="templates/app" />

### Preview

Here's what will be generated:

<BoilerplateTemplate boilerplateInputsId="config">
...
</BoilerplateTemplate>

Now click "Generate" above to create the files!
```

### 3. Show Multiple Related Files

Display an entire configuration set:

```mdx
<BoilerplateTemplate boilerplateInputsId="config" outputPath="main.tf">
...
</BoilerplateTemplate>

<BoilerplateTemplate boilerplateInputsId="config" outputPath="variables.tf">
...
</BoilerplateTemplate>

<BoilerplateTemplate boilerplateInputsId="config" outputPath="outputs.tf">
...
</BoilerplateTemplate>
```

## Limitations

- Templates must be inline (cannot reference template directories like BoilerplateInputs can)
- Generated files are not persisted to your workspace (only displayed in the UI)
- Cannot include other template files (no `{{ template "file.txt" }}` support)
- Best for simple, single-file templates or small sets of templates

## See Also

- [BoilerplateInputs](/authoring/blocks/boilerplateinputs) - For generating files to disk
- [Boilerplate Documentation](https://github.com/gruntwork-io/boilerplate) - Full Boilerplate syntax reference
