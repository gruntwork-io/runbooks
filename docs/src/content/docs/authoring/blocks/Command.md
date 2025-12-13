---
title: <Command>
---

The `<Command>` block executes shell commands or scripts with variable substitution. It's used for performing operations like deployments, resource creation, and system configuration.

## Basic Usage

```mdx
<Command 
    id="trigger-deploy" 
    command="curl -X POST https://api.example.com/deploy"
    title="Trigger Deployment"
    successMessage="Deployment triggered!"
    failMessage="Failed to trigger deployment"
/>
```

## vs. Check

Command blocks and [Check](/authoring/blocks/check/) blocks share many features in common, however they each have a distinct purpose. Check blocks are focused on _reading_ the state of the world and validating it, while Command blocks are focused on _mutating_ the state of the world to update it to what is needed.

## Props

### Required Props

- `id` (string) - Unique identifier for this command block

### Optional Props

- `title` (string) - Display title shown in the UI
- `description` (string) - Longer description of what the command does
- `command` (string) - Inline command to execute (alternative to `path`)
- `path` (string) - Path to a shell script file relative to the runbook (alternative to `command`)
- `inputsId` (string | string[]) - ID of an [Inputs](/authoring/blocks/inputs/) block to get variables from. Can be a single ID or an array of IDs. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones).
- `successMessage` (string) - Message shown when command succeeds (default: "Success")
- `failMessage` (string) - Message shown when command fails (default: "Failed")
- `runningMessage` (string) - Message shown while running (default: "Running...")

### Inline content

Instead of referencing an external `<Inputs>` block via `inputsId`, you can nest an `<Inputs>` component directly inside the Command:

```mdx
<Command 
    id="echo-message" 
    command='echo "Hello, {{ .Name }}!"'
    title="Print Greeting"
>
    <Inputs id="inline-greeting">
    ```yaml
    variables:
      - name: Name
        type: string
        description: Your name
        validations: "required"
    \```
    </Inputs>
</Command>
```

The embedded `<Inputs>` renders directly within the Command block, allowing users to fill in variables before running the command.

Other blocks can reference this Inputs block using the standard `inputsId` pattern.

## Exit Codes

The Command block interprets exit codes as follows:

- **Exit code 0**: Success ✓ (green)
- **Any other exit code**: Failure ✗ (red)

## Script-Based Commands

Instead of inline commands, you can reference external shell scripts:

```mdx
<Command 
    id="deploy-app" 
    path="scripts/deploy.sh"
    title="Deploy Application"
    description="This will deploy your application to production"
    successMessage="Deployment successful!"
    failMessage="Deployment failed. Check the logs for details."
/>
```

## With Variables

There are several ways to collect variables to customize a command or script.

### Using inputsId

The Command's command or script pulls its values from a separate Inputs block.

```mdx
<Inputs id="repo-config">
```yaml
variables:
  - name: OrgName
    type: string
    description: GitHub organization name
  - name: RepoName
    type: string
    description: Repository name
\```
</Inputs>

<Command 
    id="create-repo" 
    command="gh repo create {{ .OrgName }}/{{ .RepoName }} --private"
    inputsId="repo-config"
    title="Create GitHub Repository"
    successMessage="Repository {{ .RepoName }} created!"
    failMessage="Failed to create repository"
/>
```

### Using Inline Inputs

The Command collects input values directly. These values can be shared with other blocks, just like a standalone Inputs block.

```mdx
<Command 
    id="echo-message" 
    command='echo "Hello, {{ .Name }}!"'
    title="Print Greeting"
>
    <Inputs id="inline-greeting">
    ```yaml
    variables:
      - name: Name
        type: string
        description: Your name
        validations: "required"
    \```
    </Inputs>
</Command>
```

### Using Multiple inputsIds

You can reference multiple Inputs blocks by passing an array of IDs. Variables are merged in order, with later IDs overriding earlier ones:

```mdx
<Inputs id="lambda-config" templatePath="templates/lambda" />

<Inputs id="repo-config">
```yaml
variables:
  - name: GithubOrgName
    type: string
    description: GitHub organization name
  - name: GithubRepoName
    type: string
    description: Repository name
\```
</Inputs>

<Command 
    id="deploy-lambda" 
    path="scripts/deploy.sh"
    inputsId={["lambda-config", "repo-config"]}
    title="Deploy Lambda Function"
    description="Deploy the Lambda function using variables from both inputs"
/>
```

In this example, the command has access to all variables from both `lambda-config` and `repo-config`. If both define a variable with the same name, the value from `repo-config` (the later ID) takes precedence.

## Example Shell Scripts

The Command block accepts any executable script. Here are some common examples:

### Simple Deployment Script

```bash
#!/bin/bash
# scripts/deploy.sh

set -e  # Exit on error

echo "Starting deployment..."
kubectl apply -f deployment.yaml
kubectl rollout status deployment/myapp

echo "Deployment complete!"
```

### Parameterized Script

```bash
#!/bin/bash
# scripts/create-vpc.sh

REGION="{{ .AwsRegion }}"
VPC_NAME="{{ .VpcName }}"
CIDR_BLOCK="{{ .CidrBlock }}"

echo "Creating VPC $VPC_NAME in $REGION..."
aws ec2 create-vpc \
    --cidr-block "$CIDR_BLOCK" \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=$VPC_NAME}]" \
    --region "$REGION"

echo "VPC created successfully!"
```

### Script with Error Handling

```bash
#!/bin/bash
# scripts/safe-deploy.sh

set -e

function cleanup {
    echo "Cleaning up..."
    # Cleanup code here
}

trap cleanup EXIT

echo "Running pre-deployment checks..."
./check-prerequisites.sh || { echo "Pre-checks failed"; exit 1; }

echo "Deploying..."
./deploy.sh

echo "Running post-deployment validation..."
./validate-deployment.sh || { echo "Validation failed"; exit 1; }

echo "Deployment successful!"
```

## Common Use Cases

The `<Command>` block works especially well for mutating the world to a desired state. This could be either the user's local environment, the company's world, or the external world.

This might manifest as:

- **Installing tools**: Install tools needed to execute the runbook
- **Configure environment**: Configure the user's environment
- **Provisioning resources**: Hit an API to provision resource.
- **Deployments**: Deploy applications or infrastructure to cloud environments
- **Database Operations**: Run migrations or seed data
- **Build Steps**: Compile code or build Docker images

## Shell Execution Context

Scripts run in a **non-interactive shell**, which means shell aliases (like `ll`) and shell functions (like `nvm`, `rvm`) are **not available**. Environment variables are inherited from the process that launched Runbooks.

For full details, see [Shell Execution Context](/security/shell-execution-context/).
