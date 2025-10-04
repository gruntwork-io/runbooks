---
title: <BoilerplateInputs>
---

# `<BoilerplateInputs>` Block

The `<BoilerplateInputs>` block creates dynamic web forms based on [Boilerplate](https://github.com/gruntwork-io/boilerplate) variable definitions. It's used to collect user input that can then be used in Commands, Checks, or to generate files from templates.

## Basic Usage

### With Template Path

```mdx
<BoilerplateInputs 
    id="terraform-config" 
    templatePath="templates/terraform-vpc" 
/>
```

This loads the `boilerplate.yml` file from `templates/terraform-vpc/boilerplate.yml` (relative to your runbook file).

### With Inline YAML

```mdx
<BoilerplateInputs id="user-inputs">
```yaml
variables:
  - name: ProjectName
    type: string
    description: Name for your project
    validations: "required"
  - name: Environment
    type: enum
    description: Deployment environment
    options:
      - dev
      - staging
      - production
    default: dev
\```
</BoilerplateInputs>
```

## Props

### Required Props

- `id` (string) - Unique identifier for this form (used by Commands/Checks to reference the variables)

### Optional Props

- `templatePath` (string) - Path to a directory containing a `boilerplate.yml` file (relative to runbook)
- `prefilledVariables` (object) - Pre-filled values for form fields
- `variant` (string) - Display variant: `'standard'` (default) or `'embedded'` (for inline use in Commands/Checks)
- `children` (ReactNode) - Inline YAML content (alternative to `templatePath`)
- `onGenerate` (function) - Callback function called when form is submitted (advanced)

## Supported Variable Types

### String

Text input field:

```yaml
variables:
  - name: ProjectName
    type: string
    description: Name for your project
    default: my-project
    validations: "required"
```

### Int

Number input field:

```yaml
variables:
  - name: InstanceCount
    type: int
    description: Number of instances
    default: 3
```

### Bool

Checkbox:

```yaml
variables:
  - name: EnableMonitoring
    type: bool
    description: Enable CloudWatch monitoring
    default: true
```

### Enum

Dropdown select:

```yaml
variables:
  - name: Environment
    type: enum
    description: Deployment environment
    options:
      - dev
      - staging
      - production
    default: dev
```

### List

Dynamic list of values:

```yaml
variables:
  - name: AllowedIPs
    type: list
    description: List of allowed IP addresses
    default:
      - 0.0.0.0/0
```

### Map

Key-value pairs:

```yaml
variables:
  - name: Tags
    type: map
    description: AWS resource tags
    default:
      Environment: dev
      Owner: team
```

### Structured Map (with Schema)

Map with predefined fields:

```yaml
variables:
  - name: Accounts
    type: map
    description: AWS accounts configuration
    schema:
      email: string
      environment: string
      id: string
    schemaInstanceLabel: Account Name
    default:
      dev:
        email: dev@example.com
        environment: development
        id: "123456789012"
      prod:
        email: prod@example.com
        environment: production
        id: "098765432109"
```

## Validations

Boilerplate supports various validation types:

```yaml
variables:
  - name: Email
    type: string
    validations:
      - type: required
        message: Email is required
      - type: email
        message: Must be a valid email address

  - name: Region
    type: string
    validations:
      - type: required
      - type: length
        args: [2, 20]
        message: Region must be between 2 and 20 characters

  - name: ProjectName
    type: string
    validations:
      - type: alphanumeric
        message: Project name must be alphanumeric
```

Supported validation types:
- `required` - Field must not be empty
- `email` - Must be a valid email address
- `url` - Must be a valid URL
- `alpha` - Letters only
- `digit` - Numbers only
- `alphanumeric` - Letters and numbers only
- `semver` - Valid semantic version (e.g., 1.2.3)
- `length` - String length range (args: [min, max])
- `countrycode2` - Two-letter country code

## Using with Commands and Checks

### Reference by ID

```mdx
<BoilerplateInputs id="vpc-config">
```yaml
variables:
  - name: VpcName
    type: string
  - name: CidrBlock
    type: string
    default: 10.0.0.0/16
\```
</BoilerplateInputs>

<Command 
    id="create-vpc" 
    command="aws ec2 create-vpc --cidr-block {{ .CidrBlock }} --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value={{ .VpcName }}}]'"
    boilerplateInputsId="vpc-config"
    title="Create VPC"
/>
```

### Inline (Embedded)

```mdx
<Command 
    id="echo-greeting" 
    command='echo "Hello, {{ .Name }}!"'
>
    <BoilerplateInputs id="inline-name">
    ```yaml
    variables:
      - name: Name
        type: string
        description: Your name
    \```
    </BoilerplateInputs>
</Command>
```

## Generating Files

When you provide a `templatePath`, users can click "Generate" to create files from templates using Boilerplate:

```mdx
<BoilerplateInputs 
    id="vpc-template" 
    templatePath="templates/vpc" 
/>
```

Directory structure:
```
templates/vpc/
├── boilerplate.yml
├── main.tf
├── variables.tf
└── outputs.tf
```

The template files can use Boilerplate syntax:
```hcl
# main.tf
resource "aws_vpc" "main" {
  cidr_block = "{{ .CidrBlock }}"
  
  tags = {
    Name = "{{ .VpcName }}"
    Environment = "{{ .Environment }}"
  }
}
```

Generated files are saved to a `generated/` directory by default and displayed in a file tree in the UI.

## Form Features

### Auto-Render

When used inline with Commands/Checks, the form automatically re-renders the command/check as the user types (with debouncing).

### Generate Button

For standalone BoilerplateInputs with a `templatePath`, a "Generate" button appears. Clicking it:
1. Validates all form inputs
2. Calls the backend API to render the template
3. Displays a file tree of generated files
4. Shows a success indicator

### Success Indicator

After successful generation, a green checkmark appears showing that files were generated.

### Form Validation

The form validates inputs in real-time based on the validation rules defined in the boilerplate.yml.

## Complete Example

```mdx
# Deploy a VPC

First, configure your VPC settings:

<BoilerplateInputs id="vpc-setup" templatePath="templates/vpc" />

The form above will generate Terraform files. Now let's validate and apply:

<Check 
    id="validate-terraform" 
    command="cd generated && terraform validate"
    title="Validate Terraform Configuration"
    successMessage="Terraform configuration is valid!"
/>

<Command 
    id="apply-terraform" 
    command="cd generated && terraform init && terraform apply -auto-approve"
    title="Deploy VPC"
    successMessage="VPC deployed successfully!"
    failMessage="VPC deployment failed. Check logs."
/>

<Check 
    id="verify-vpc" 
    command="aws ec2 describe-vpcs --filters Name=tag:Name,Values={{ .VpcName }}"
    boilerplateInputsId="vpc-setup"
    title="Verify VPC Was Created"
    successMessage="VPC exists!"
/>
```

## Best Practices

### 1. Use Clear Descriptions

```yaml
variables:
  - name: BucketName
    type: string
    description: S3 bucket name (must be globally unique, lowercase, no spaces)
    validations: "required"
```

### 2. Provide Sensible Defaults

```yaml
variables:
  - name: Environment
    type: enum
    description: Deployment environment
    options: [dev, staging, production]
    default: dev  # Most common choice
```

### 3. Use Validation Rules

Always validate required fields and add format validation where appropriate:

```yaml
variables:
  - name: Email
    type: string
    validations:
      - type: required
      - type: email
```

### 4. Group Related Inputs

Use multiple BoilerplateInputs blocks to group related configuration:

```mdx
## Network Configuration
<BoilerplateInputs id="network-config" templatePath="templates/network" />

## Application Configuration
<BoilerplateInputs id="app-config" templatePath="templates/app" />
```

### 5. Use Enum for Fixed Choices

When users need to pick from a fixed set of options, use enum instead of string:

```yaml
# Good
- name: Region
  type: enum
  options: [us-east-1, us-west-2, eu-west-1]

# Less good
- name: Region
  type: string
  description: AWS region (e.g., us-east-1)
```

## Common Use Cases

- **Configuration Collection**: Gather parameters before running commands
- **Template Generation**: Generate IaC files, config files, or any templated content
- **Parameterized Operations**: Provide inputs for commands and checks
- **Multi-Step Workflows**: Collect inputs once and use across multiple steps

## Advanced: Structured Maps

For complex data structures like AWS accounts, use structured maps:

```yaml
variables:
  - name: AwsAccounts
    type: map
    description: AWS account configurations
    schema:
      email: string
      environment: string
      account_id: string
    schemaInstanceLabel: Account
    default:
      logs:
        email: aws-logs@example.com
        environment: shared
        account_id: "111111111111"
      security:
        email: aws-security@example.com
        environment: shared
        account_id: "222222222222"
```

This renders a structured form where users can add/remove accounts and fill in the required fields for each.
