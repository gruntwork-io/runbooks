---
title: <Command>
---

The `<Command>` block executes shell commands or scripts with variable substitution. It's used for performing operations like deployments, resource creation, and system configuration.

## Basic Usage

### Simple Command

```mdx
<Command 
    id="list-files" 
    command="ls -la"
    title="List Current Directory"
    successMessage="Directory listing complete!"
    failMessage="Failed to list directory"
/>
```

### Script-Based Command

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

## Props

### Required Props

- `id` (string) - Unique identifier for this command block

### Optional Props

- `title` (string) - Display title shown in the UI
- `description` (string) - Longer description of what the command does
- `command` (string) - Inline command to execute (alternative to `path`)
- `path` (string) - Path to a shell script file relative to the runbook (alternative to `command`)
- `boilerplateInputsId` (string) - ID of a BoilerplateInputs block to get variables from
- `successMessage` (string) - Message shown when command succeeds (default: "Success")
- `failMessage` (string) - Message shown when command fails (default: "Failed")
- `runningMessage` (string) - Message shown while running (default: "Running...")
- `children` (ReactNode) - Inline BoilerplateInputs component for parameterized commands

## Exit Codes

Commands interpret exit codes as:

- **Exit code 0**: Success ✓ (green)
- **Any other exit code**: Failure ✗ (red)

## With Variables

### Using boilerplateInputsId

```mdx
<BoilerplateInputs id="repo-config">
```yaml
variables:
  - name: OrgName
    type: string
    description: GitHub organization name
  - name: RepoName
    type: string
    description: Repository name
\```
</BoilerplateInputs>

<Command 
    id="create-repo" 
    command="gh repo create {{ .OrgName }}/{{ .RepoName }} --private"
    boilerplateInputsId="repo-config"
    title="Create GitHub Repository"
    successMessage="Repository {{ .RepoName }} created!"
    failMessage="Failed to create repository"
/>
```

### Using Inline BoilerplateInputs

```mdx
<Command 
    id="echo-message" 
    command='echo "Hello, {{ .Name }}!"'
    title="Print Greeting"
>
    <BoilerplateInputs id="inline-greeting">
    ```yaml
    variables:
      - name: Name
        type: string
        description: Your name
        validations: "required"
    \```
    </BoilerplateInputs>
</Command>
```

## Variable Substitution

Commands support Go template syntax for variable substitution:

### Basic Variable Insertion

```mdx
<Command command="echo {{ .VarName }}" ... />
```

### String Manipulation

```mdx
<!-- Uppercase -->
<Command command="echo {{ .Name | upper }}" ... />

<!-- Lowercase -->
<Command command="echo {{ .Email | lower }}" ... />
```

### Conditional Logic

```mdx
<Command 
    command='{{if .EnableLogging}}echo "Logging enabled"{{else}}echo "Logging disabled"{{end}}'
    ...
/>
```

### Complex Command with Multiple Variables

```mdx
<Command 
    command='aws s3 mb s3://{{ .BucketName }} --region {{ .Region }} {{if .EnableVersioning}}--enable-versioning{{end}}'
    boilerplateInputsId="s3-config"
/>
```

## Example Shell Scripts

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

## Features

### Skip Checkbox
Commands have a "Skip" checkbox in the UI. Users can skip optional commands. Once a command succeeds, the skip checkbox is disabled.

### View Source Code
For path-based commands, users can expand the "View Source Code" section to see the script contents. The UI shows:
- Programming language (detected from file extension)
- Number of lines
- File path
- Link to expand source code

### View Logs
The output (stdout/stderr) from the command is shown in real-time in an expandable "View Logs" section.

### Stop Button
While a command is running, users can click "Stop" to terminate execution.

## Best Practices

### 1. Use Set -e in Scripts

Always use `set -e` in bash scripts to exit on errors:

```bash
#!/bin/bash
set -e

# Script will exit if any command fails
```

### 2. Provide Clear Output

Use echo statements to provide feedback:

```bash
#!/bin/bash
echo "Step 1: Configuring environment..."
configure_env

echo "Step 2: Running tests..."
run_tests

echo "Step 3: Deploying..."
deploy

echo "All done!"
```

### 3. Use Descriptive Titles and Messages

```mdx
<Command 
    id="deploy-prod" 
    path="scripts/deploy.sh"
    title="Deploy to Production"
    description="This will deploy your application to the production environment. Make sure you've reviewed the changes."
    successMessage="Production deployment complete! Application is now live."
    failMessage="Production deployment failed. Check logs and rollback if necessary."
/>
```

### 4. Validate Inputs in Scripts

```bash
#!/bin/bash

if [ -z "{{ .BucketName }}" ]; then
    echo "Error: BucketName is required"
    exit 1
fi

# Rest of script...
```

### 5. Make Commands Idempotent When Possible

Design commands that can be run multiple times without causing issues:

```bash
#!/bin/bash
# Create S3 bucket only if it doesn't exist

if aws s3 ls "s3://{{ .BucketName }}" 2>/dev/null; then
    echo "Bucket already exists, skipping creation"
else
    echo "Creating bucket..."
    aws s3 mb "s3://{{ .BucketName }}"
fi
```

### 6. Use Multi-line Commands for Readability

```mdx
<Command 
    id="configure-cluster" 
    command={`
        kubectl create namespace {{ .Namespace }} && \
        kubectl apply -f config.yaml -n {{ .Namespace }} && \
        kubectl wait --for=condition=ready pod -l app={{ .AppName }} -n {{ .Namespace }}
    `}
    title="Configure Kubernetes Cluster"
/>
```

## Common Use Cases

- **Deployments**: Deploy applications to various environments
- **Resource Creation**: Create cloud resources (S3 buckets, VPCs, etc.)
- **Configuration**: Apply configuration changes
- **Data Migration**: Run database migrations or data transfers
- **Testing**: Execute test suites
- **Cleanup**: Delete temporary resources or clean up environments
- **Git Operations**: Create repos, commit changes, create PRs

## Security Considerations

### Avoid Hardcoded Secrets

Never hardcode secrets in commands. Use environment variables or secret management:

```mdx
<!-- BAD -->
<Command command="aws s3 cp file.txt s3://bucket --secret MY_SECRET_KEY" />

<!-- GOOD -->
<Command command="aws s3 cp file.txt s3://bucket" />
<!-- Assume AWS credentials are configured via AWS CLI or environment -->
```

### Be Careful with User Input

When using user-provided variables, be aware of injection risks. Validate inputs in your scripts:

```bash
#!/bin/bash

# Validate input
if [[ ! "{{ .BucketName }}" =~ ^[a-z0-9.-]+$ ]]; then
    echo "Invalid bucket name format"
    exit 1
fi
```

### Review Commands Before Execution

Encourage users to review commands before running them, especially for destructive operations. Use descriptive titles and descriptions to make it clear what will happen.
