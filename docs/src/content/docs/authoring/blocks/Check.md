---
title: <Check>
---

The `<Check>` block validates a user's system state by running shell commands or scripts. It's essential for ensuring users have the right tools installed and their environment is properly configured before proceeding.

## Basic Usage

```mdx
<Check 
    id="check-git" 
    command="git --version"
    title="Check if Git is installed"
    description="We need Git for version control"
    successMessage="Git is installed!"
    failMessage="Git is not installed. Please install it from https://git-scm.com/"
/>
```

## Props

### Required Props

- `id` (string) - Unique identifier for this check block

### Optional Props

- `title` (string) - Display title shown in the UI
- `description` (string) - Longer description of what's being checked
- `command` (string) - Inline command to execute (alternative to `path`)
- `path` (string) - Path to a shell script file relative to the runbook (alternative to `command`)
- `inputsId` (string | string[]) - ID of an [Inputs](/authoring/blocks/inputs/) block to get variables from. Can be a single ID or an array of IDs. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones).
- `successMessage` (string) - Message shown when check succeeds (default: "Success")
- `warnMessage` (string) - Message shown on warning (default: "Warning")
- `failMessage` (string) - Message shown when check fails (default: "Failed")
- `runningMessage` (string) - Message shown while running (default: "Checking...")

### Inline content

Instead of referencing an external `<Inputs>` block via `inputsId`, you can nest an `<Inputs>` component directly inside the Check:

```mdx
<Check 
    id="check-s3-bucket" 
    path="checks/s3-bucket-exists.sh"
    title="Verify S3 Bucket Exists"
>
    <Inputs id="bucket-config">
    ```yaml
    variables:
      - name: BucketName
        type: string
        description: Name of the S3 bucket to check
        validations: "required"
    \```
    </Inputs>
</Check>
```

The embedded `<Inputs>` renders directly within the Check block, allowing users to fill in variables before running the check.

Other blocks can reference this Inputs block using the standard `inputsId` pattern.

## Exit Codes

The Check block interprets exit codes as follows:

- **Exit code 0**: Success ✓ (green)
- **Exit code 1**: Failure ✗ (red)
- **Exit code 2**: Warning ⚠ (yellow)

## Script-Based Checks

Instead of inline commands, you can reference external shell scripts:

```mdx
<Check 
    id="check-aws-auth" 
    path="checks/aws-authenticated.sh"
    title="Verify AWS Authentication"
    description="Checking if you're authenticated to AWS"
    successMessage="AWS credentials are valid!"
    failMessage="AWS authentication failed. Run 'aws configure' to set up credentials."
/>
```

## With Variables

There are several ways to collect variables to customize a check's command or script.

### Using inputsId

The Check command or script ulls its values from a separate Inputs block.

```mdx
<Inputs id="region-config">
```yaml
variables:
  - name: AwsRegion
    type: string
    description: AWS region to check
    default: us-east-1
\```
</Inputs>

<Check 
    id="check-region" 
    command="aws ec2 describe-availability-zones --region {{ .AwsRegion }}"
    inputsId="region-config"
    title="Check AWS Region Accessibility"
    successMessage="Region {{ .AwsRegion }} is accessible!"
    failMessage="Cannot access region {{ .AwsRegion }}"
/>
```

### Using Inline Inputs

The Check command collects input values directly. These values can be shared with other blocks, just like a standalone Inputs block.

```mdx
<Check 
    id="check-kms-key" 
    path="checks/kms-validation.sh"
    title="Validate KMS Key"
>
    <Inputs id="inline-kms">
    ```yaml
    variables:
      - name: KmsKeyId
        type: string
        description: KMS Key ID to validate
        validations: "required"
    \```
    </Inputs>
</Check>
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
  - name: GithubRepoName
    type: string
\```
</Inputs>

<Check 
    id="check-lambda" 
    path="checks/test-lambda.sh"
    inputsId={["lambda-config", "repo-config"]}
    title="Test Lambda Function"
/>
```

In this example, the check has access to all variables from both `lambda-config` and `repo-config`. If both define a variable with the same name, the value from `repo-config` (the later ID) takes precedence.

## Example Shell Scripts

The Check block accepts any executable script. Here are some common examples:

### Basic Validation Script

```bash
#!/bin/bash
# checks/terraform-installed.sh

if command -v terraform &> /dev/null; then
    echo "Terraform is installed: $(terraform version)"
    exit 0
else
    echo "Terraform is not installed"
    exit 1
fi
```

### Script with Warning

```bash
#!/bin/bash
# checks/disk-space.sh

available=$(df -h / | awk 'NR==2 {print $4}' | sed 's/G//')

if [ "$available" -lt 1 ]; then
    echo "Critical: Less than 1GB available"
    exit 1
elif [ "$available" -lt 5 ]; then
    echo "Warning: Less than 5GB available"
    exit 2
else
    echo "Disk space OK: ${available}GB available"
    exit 0
fi
```

### Parameterized Script

```bash
#!/bin/bash
# checks/s3-bucket-exists.sh

BUCKET_NAME="{{ .BucketName }}"

if aws s3 ls "s3://${BUCKET_NAME}" &> /dev/null; then
    echo "Bucket ${BUCKET_NAME} exists"
    exit 0
else
    echo "Bucket ${BUCKET_NAME} does not exist"
    exit 1
fi
```

## Common Use Cases

The `<Check>` block works especially well for:

- Pre-flight checks
- Validating `<Command>` blocks
- Smoke tests that validate a completed Runbook

This might manifest as:

- **Tool Installation Verification**: Check if required CLI tools are installed
- **Authentication Validation**: Verify users are logged into required services
- **Infrastructure State**: Validate that required resources exist
- **Configuration Validation**: Ensure config files are properly formatted
- **Network Connectivity**: Test connectivity to required services
- **Permissions**: Verify users have necessary permissions

## Shell Execution Context

Scripts run in a **non-interactive shell**, which means shell aliases (like `ll`) and shell functions (like `nvm`, `rvm`) are **not available**. Environment variables are inherited from the process that launched Runbooks.

For full details, see [Shell Execution Context](/security/shell-execution-context/).
