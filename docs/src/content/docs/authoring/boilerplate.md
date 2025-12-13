---
title: Boilerplate Templates
---

# Gruntwork Boilerplate

[Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate) is a tool for generating files and folders from templates. Runbooks uses Boilerplate under the hood for all template rendering—this includes the `<Template>`, `<TemplateInline>`, `<Inputs>`, `<Command>`, and `<Check>` blocks.

This page covers the aspects of Boilerplate most relevant to Runbook authors. For the complete Boilerplate documentation, see the [official Boilerplate repo](https://github.com/gruntwork-io/boilerplate).

## Boilerplate in a nutshell

Boilerplate is a template engine, similar to [Jinja](https://jinja.palletsprojects.com/en/stable/), [Nunjucks](https://mozilla.github.io/nunjucks/), or [Cookiecutter](https://cookiecutter.readthedocs.io/en/stable/).

### Why boilerplate

Boilerplate is differentiated by being purpose-built for DevOps and infrastructure use cases, which gives it a few key features:

1. **Interactive mode:** When used as a CLI tool, boilerplate interactively prompts the user for a set of variables defined in a `boilerplate.yml` file and makes those variables available to your project templates during copying.
2. **Non-interactive mode:** Variables can also be set non-interactively, via command-line options, so that Boilerplate can be used in automated settings (e.g. during automated tests).
3. **Flexible templating:** Boilerplate uses Go Template for templating, which gives you the ability to do formatting, conditionals, loops, and call out to Go functions. It also includes helpers for common tasks such as loading the contents of another file, executing a shell command and rendering the output in a template, and including partial templates.
4. **Dependencies.** You can "chain" templates together, conditionally including other templates depending on variable values.
5. **Variable types:** Boilerplate variables support types, so you have first-class support for strings, ints, bools, lists, maps, and enums.
6. **Validations:** Boilerplate provides a set of validations for a given variable that user input must satisfy.
7. **Scripting:** Need more power than static templates and variables? Boilerplate includes several hooks that allow you to run arbitrary scripts.
8. **Cross-platform:** Boilerplate is easy to install (it's a standalone binary) and works on all major platforms (Mac, Linux, Windows).

### Quick example

Say you want to generate a README for new projects. Create a template folder:

```
my-template/
├── boilerplate.yml
└── README.md
```

**`boilerplate.yml`** — defines the variables:

```yaml
variables:
  - name: ProjectName
    type: string
    description: Name of the project

  - name: Author
    type: string
    description: Who is the author?
    default: Anonymous
```

**`README.md`** — the template file:

```markdown
# {{ .ProjectName }}

Created by {{ .Author }}.
```

**Run boilerplate on the command line:**

```bash
boilerplate \
  --template-url ./my-template \
  --output-folder ./output \
  --var ProjectName="My Cool App" \
  --var Author="Jane Doe"
```

**Result** — `output/README.md`:

```markdown
# My Cool App

Created by Jane Doe.
```

That's it! Boilerplate takes your template, substitutes the variables, and writes the output.

## What Boilerplate Does for Runbooks

In Runbooks, Boilerplate provides:

1. **Variable definitions** — A YAML schema (`boilerplate.yml`) that defines what inputs users need to provide, including types, defaults, and validation rules.
2. **Template syntax** — Go template syntax for rendering dynamic content in generated files, scripts, and commands.
3. **File generation** — The ability to generate multiple files from templates with user-provided values.

## The `boilerplate.yml` File

Every template directory needs a `boilerplate.yml` file that defines the variables users will fill in. Runbooks reads this file to render interactive forms in the UI.

### Basic Structure

```yaml
variables:
  - name: ProjectName
    type: string
    description: What would you like to call your project?
    default: my-project
    validations: "required"

  - name: Environment
    type: enum
    description: Which environment is this for?
    options:
      - dev
      - staging
      - prod
    default: dev
```

This generates a form with a text input for `ProjectName` and a dropdown for `Environment`.

### Variable Properties

Each variable supports these properties:

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Variable name (used in templates as `.Name`) |
| `type` | No | Data type: `string`, `int`, `bool`, `enum`, `list`, `map` (defaults to `string`) |
| `description` | No | Help text shown in the form |
| `default` | No | Default value |
| `options` | For `enum` | List of allowed values for dropdowns |
| `validations` | No | Validation rules (see below) |

## Variable Types

### `string`

Text input field.

```yaml
- name: BucketName
  type: string
  description: Name for the S3 bucket
  default: my-bucket
```

### `int`

Numeric input field.

```yaml
- name: InstanceCount
  type: int
  description: Number of instances to deploy
  default: 3
```

### `bool`

Checkbox toggle.

```yaml
- name: EnableLogging
  type: bool
  description: Enable CloudWatch logging?
  default: true
```

### `enum`

Dropdown select from predefined options.

```yaml
- name: Region
  type: enum
  description: AWS region for deployment
  options:
    - us-east-1
    - us-west-2
    - eu-west-1
  default: us-east-1
```

### `list`

Dynamic list of values. Users can add/remove items.

```yaml
- name: AllowedIPs
  type: list
  description: IP addresses to allow
  default: []
```

### `map`

Key-value pairs. Users can add/remove entries.

```yaml
- name: Tags
  type: map
  description: Resource tags
  default: {}
```

For more complex structured data, see [x-schema](#x-schema) below.

## Validations

Add validation rules to ensure user input meets requirements:

```yaml
- name: ProjectName
  type: string
  validations: "required"

- name: ContactEmail
  type: string
  validations: "email"

- name: WebsiteURL
  type: string
  validations: "url"

- name: Identifier
  type: string
  validations: "alphanumeric"

- name: CountryCode
  type: string
  validations: "countrycode2"

- name: Version
  type: string
  validations: "semver"

- name: ManyValidations
  type: string
  validations:
  - "required"
  - "email"
```

### Custom Error Messages

For custom error messages, use the object format with `type` and `message`:

```yaml
variables:
  - name: Email
    type: string
    validations:
      - type: required
        message: Email is required
      - type: email
        message: Must be a valid email address
```

### Available Validation Types

| Validation | Description |
|------------|-------------|
| `required` | Field cannot be empty |
| `email` | Must be a valid email address |
| `url` | Must be a valid URL |
| `alpha` | Only letters allowed (no numbers or special characters) |
| `digit` | Only digits allowed (0-9) |
| `alphanumeric` | Only letters and numbers allowed |
| `countrycode2` | Must be a valid two-letter country code (ISO 3166-1 alpha-2) |
| `semver` | Must be a valid semantic version (e.g., `1.0.0`, `2.1.3-beta`) |

## Template Syntax

Template files use Go template syntax. Variables from `boilerplate.yml` are accessed using dot notation:

### Basic Variable Substitution

```hcl
resource "aws_s3_bucket" "main" {
  bucket = "{{ .BucketName }}-{{ .Environment }}"
}
```

### Conditionals

```hcl
{{- if .EnableLogging }}
resource "aws_cloudwatch_log_group" "main" {
  name = "/app/{{ .ProjectName }}"
}
{{- end }}
```

### Comparisons

```hcl
instance_type = "{{ if eq .Environment "prod" }}t3.large{{ else }}t3.micro{{ end }}"
```

### Loops

```hcl
{{- range .AllowedIPs }}
  - {{ . }}
{{- end }}
```

### Working with Maps

```hcl
tags = {
{{- range $key, $value := .Tags }}
  {{ $key }} = "{{ $value }}"
{{- end }}
}
```

### Whitespace Control

Use `-` to trim whitespace around template directives:

- `{{-` trims whitespace before
- `-}}` trims whitespace after

```hcl
{{- if .Description }}
description = "{{ .Description }}"
{{- end }}
```

## Built-in Helper Functions

Boilerplate includes helper functions for common transformations:

```yaml
# String case transformations
{{ .ProjectName | snakeCase }}    # my_project
{{ .ProjectName | camelCase }}    # myProject
{{ .ProjectName | pascalCase }}   # MyProject
{{ .ProjectName | kebabCase }}    # my-project
{{ .ProjectName | upper }}        # MY-PROJECT
{{ .ProjectName | lower }}        # my-project

# String checks
{{ hasPrefix "prod" .Environment }}  # true if starts with "prod"
{{ hasSuffix "-dev" .Name }}         # true if ends with "-dev"
```

## Dynamic File Names

Boilerplate supports template syntax in file names. This lets you generate files with dynamic names based on variables:

```
templates/
├── boilerplate.yml
├── {{ .ProjectName }}.tf
└── {{ .Environment }}/
    └── config.yaml
```

With `ProjectName: "vpc"` and `Environment: "prod"`, this generates:

```
vpc.tf
prod/
└── config.yaml
```

## Runbooks Extensions

Runbooks extends Boilerplate with additional YAML properties (prefixed with `x-`) for enhanced UI rendering. These are ignored by the standard Boilerplate CLI but enable richer form experiences in Runbooks.

### `x-section`

A large number of fields on a form can be overwhelming for users. Sections allow you to _group_ fields under a named heading so that you can organize a large number of fields into a discrete number of sections.

In this example, the form will render with two sections: "Basic Settings", "Advanced Settings"

```yaml
variables:
  - name: FunctionName
    type: string
    x-section: Basic Settings

  - name: Runtime
    type: enum
    options: [python3.12, nodejs20.x]
    x-section: Basic Settings

  - name: MemorySize
    type: int
    default: 128
    x-section: Advanced Settings

  - name: Timeout
    type: int
    default: 30
    x-section: Advanced Settings
```

Variables without `x-section` appear in an unnamed section at the top.

### `x-schema`

Sometimes you want to collect a "map" of key-value pairs from users, where the value is a simple string. But in other cases, you want a _collection_ of values for each key. For example, if you want to prompt a user to declare their current AWS accounts, each AWS account has an email address, account ID, and descriptive name. 

In these scenarios, you can define a _schema_ for `map` type variables so that Runbooks will render a structured form instead of free-form key-value inputs:

```yaml
- name: AWSAccounts
  type: map
  description: AWS account configuration
  x-schema:
    email: string
    name: string
    id: string
```

This renders a form where each map entry has three typed fields instead of arbitrary key-value pairs.

### `x-schema-instance-label`

Customize the label for each instance of a key-value pair in a schema-based map:

```yaml
- name: AWSAccounts
  type: map
  description: AWS account configuration
  x-schema-instance-label: AWS Account Name
  x-schema:
    email: string
    environment: string
    id: string
```

## Authoring Templates with the CLI

While Runbooks provides a live preview experience, you can also use the Boilerplate CLI directly to test templates during development.

### Install Boilerplate

```bash
# macOS
brew install gruntwork-io/tap/boilerplate

# Or download from GitHub releases
# https://github.com/gruntwork-io/boilerplate/releases
```

### Generate Files

```bash
boilerplate \
  --template-url ./templates/vpc \
  --output-folder ./output \
  --var VpcName="my-vpc" \
  --var Environment="dev"
```

### Interactive Mode

Without `--var` flags, Boilerplate prompts for values interactively:

```bash
boilerplate \
  --template-url ./templates/vpc \
  --output-folder ./output
```

### Non-Interactive Mode

Use `--non-interactive` with a vars file for CI/CD:

```bash
boilerplate \
  --template-url ./templates/vpc \
  --output-folder ./output \
  --var-file vars.yml \
  --non-interactive
```

## Example: Complete Template

Here's a complete example showing a template directory structure:

```
templates/lambda/
├── boilerplate.yml
├── main.tf
├── variables.tf
└── outputs.tf
```

**`boilerplate.yml`:**

```yaml
variables:
  - name: FunctionName
    type: string
    description: Name for the Lambda function
    validations: "required"
    x-section: Basic Settings

  - name: Runtime
    type: enum
    description: Lambda runtime
    options:
      - python3.12
      - nodejs20.x
    default: python3.12
    x-section: Basic Settings

  - name: MemorySize
    type: int
    description: Memory in MB (128-10240)
    default: 128
    x-section: Advanced Settings

  - name: EnableLogging
    type: bool
    description: Create CloudWatch log group?
    default: true
    x-section: Advanced Settings

  - name: Tags
    type: map
    description: Resource tags
    default: {}
    x-section: Advanced Settings
```

**`main.tf`:**

```hcl
resource "aws_lambda_function" "main" {
  function_name = "{{ .FunctionName }}"
  runtime       = "{{ .Runtime }}"
  memory_size   = {{ .MemorySize }}
  handler       = "index.handler"
  role          = aws_iam_role.lambda.arn

  tags = {
{{- range $key, $value := .Tags }}
    {{ $key }} = "{{ $value }}"
{{- end }}
  }
}

{{- if .EnableLogging }}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/{{ .FunctionName }}"
  retention_in_days = 14
}
{{- end }}
```

## Using Templates in Runbooks

Once you've created a template, reference it in your runbook:

```mdx
# Deploy a Lambda Function

Configure your Lambda function below:

<Template id="lambda-config" path="templates/lambda" />

After generating, review the files in the file tree on the right.
```

For inline templates that don't need a separate directory:

`````mdx
<Inputs id="config">
```yaml
variables:
  - name: BucketName
    type: string
```
</Inputs>

<TemplateInline inputsId="config" outputPath="bucket.tf">
```hcl
resource "aws_s3_bucket" "main" {
  bucket = "{{ .BucketName }}"
}
```
</TemplateInline>
`````

