---
title: <Check>
---

The `<Check>` block validates prerequisites and system state by running shell commands or scripts. It's essential for ensuring users have the right tools installed and their environment is properly configured before proceeding.

## Basic Usage

### Simple Command Check

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

### Script-Based Check

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

## Props

### Required Props

- `id` (string) - Unique identifier for this check block

### Optional Props

- `title` (string) - Display title shown in the UI
- `description` (string) - Longer description of what's being checked
- `command` (string) - Inline command to execute (alternative to `path`)
- `path` (string) - Path to a shell script file relative to the runbook (alternative to `command`)
- `boilerplateInputsId` (string) - ID of a BoilerplateInputs block to get variables from
- `successMessage` (string) - Message shown when check succeeds (default: "Success")
- `warnMessage` (string) - Message shown on warning (default: "Warning")
- `failMessage` (string) - Message shown when check fails (default: "Failed")
- `runningMessage` (string) - Message shown while running (default: "Checking...")
- `children` (ReactNode) - Inline BoilerplateInputs component for parameterized checks

## Exit Codes

The Check block interprets exit codes as follows:

- **Exit code 0**: Success ✓ (green)
- **Exit code 1**: Failure ✗ (red)
- **Exit code 2**: Warning ⚠ (yellow)

## With Variables

### Using boilerplateInputsId

```mdx
<BoilerplateInputs id="region-config">
```yaml
variables:
  - name: AwsRegion
    type: string
    description: AWS region to check
    default: us-east-1
\```
</BoilerplateInputs>

<Check 
    id="check-region" 
    command="aws ec2 describe-availability-zones --region {{ .AwsRegion }}"
    boilerplateInputsId="region-config"
    title="Check AWS Region Accessibility"
    successMessage="Region {{ .AwsRegion }} is accessible!"
    failMessage="Cannot access region {{ .AwsRegion }}"
/>
```

### Using Inline BoilerplateInputs

```mdx
<Check 
    id="check-kms-key" 
    path="checks/kms-validation.sh"
    title="Validate KMS Key"
>
    <BoilerplateInputs id="inline-kms">
    ```yaml
    variables:
      - name: KmsKeyId
        type: string
        description: KMS Key ID to validate
        validations: "required"
    \```
    </BoilerplateInputs>
</Check>
```

## Example Shell Scripts

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

## Features

### Skip Checkbox
All checks have a "Skip" checkbox in the UI. Users can skip non-critical checks if needed. Once a check succeeds, the skip checkbox is disabled.

### View Source Code
For path-based checks, users can expand the "View Source Code" section to see the script contents.

### View Logs
The output (stdout/stderr) from the check command is shown in an expandable "View Logs" section.

### Auto-Open Logs
When a check is running, the logs section automatically opens. If a check fails, the logs remain open.

## Best Practices

### 1. Check Prerequisites First

Always put checks at the beginning of your runbook to validate the environment:

```mdx
## Prerequisites

<Check id="check-git" command="git --version" ... />
<Check id="check-terraform" command="terraform --version" ... />
<Check id="check-aws" command="aws --version" ... />
```

### 2. Provide Helpful Failure Messages

Include actionable information in failure messages:

```mdx
<Check 
    id="check-docker" 
    command="docker --version"
    failMessage="Docker is not installed. Install it from https://docs.docker.com/get-docker/"
/>
```

### 3. Use Exit Code 2 for Warnings

Use warnings when something is not ideal but not critical:

```bash
#!/bin/bash
if [ "$VERSION" != "$LATEST" ]; then
    echo "You're using an older version. Consider upgrading."
    exit 2  # Warning
fi
```

### 4. Make Checks Fast

Keep checks quick so users don't wait too long. Avoid checks that take more than a few seconds.

### 5. Group Related Checks

Use Admonition blocks to group related checks:

```mdx
<Admonition type="info" title="Pre-flight Checks" />

<Check id="check-1" ... />
<Check id="check-2" ... />
<Check id="check-3" ... />
```

## Common Use Cases

- **Tool Installation Verification**: Check if required CLI tools are installed
- **Authentication Validation**: Verify users are logged into required services
- **Infrastructure State**: Validate that required resources exist
- **Configuration Validation**: Ensure config files are properly formatted
- **Network Connectivity**: Test connectivity to required services
- **Permissions**: Verify users have necessary permissions
