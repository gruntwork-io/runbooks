---
title: <Check>
---

The `<Check>` block validates a user's system state by running shell commands or scripts. It's used to ensure that users have the right tools installed and their environment is properly configured before proceeding.

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

## vs. Command

Check blocks and [Command](/authoring/blocks/command/) blocks share many features in common, however they each have a distinct purpose. Check blocks are focused on _reading_ the state of the world and validating it, while Command blocks are focused on _mutating_ the state of the world to update it to what is needed.

## Props

### Required Props

- `id` (string) - Unique identifier for this check block
- `title` (string) - Display title shown in the UI

### Optional Props
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

## Writing Scripts

Check blocks run shell scripts to enable users to run some kind of validation.

Scripts can be defined inline using the `command` prop or stored in external files using the `path` prop.

When writing scripts for Check blocks:

- **Exit codes matter.** Return `0` for success, `1` for failure, or `2` for warning
- **Use logging helpers.** Standardized functions like `log_info` and `log_error` are available
- **Templatize with variables.** Use `{{ .VariableName }}` syntax to inject user input

Scripts run in a non-interactive shell environment. See [Execution Context](#execution-context) for details.

### Defining Scripts

You can write scripts either inline or by referencing script files.

#### Inline Scripts

For simple checks, you can define the script directly in the `command` prop:

```mdx
<Check 
    id="check-git" 
    command="git --version"
    title="Check if Git is installed"
    successMessage="Git is installed!"
    failMessage="Git is not installed."
/>
```

Inline scripts work best for one-liners or short commands. For anything more complex, use an external script file.

#### External Scripts

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

External scripts are plain old bash scripts. The referenced script `checks/aws-authenticated.sh` might look like:

```bash
#!/bin/bash

log_info "Checking AWS authentication..."

if aws sts get-caller-identity &>/dev/null; then
    log_info "AWS credentials are valid"
    exit 0
else
    log_error "Not authenticated to AWS"
    exit 1
fi
```

### Exit Codes

The Check block interprets your script's exit codes as follows:

- **Exit code 0**: Success ✓ (green)
- **Exit code 1**: Failure ✗ (red)
- **Exit code 2**: Warning ⚠ (yellow)

These exit codes will determine how the Runbooks UI renders the result of running a script.

### Logging

Runbooks provides standardized logging functions for your scripts by automatically importing a [logging.sh file](https://github.com/gruntwork-io/runbooks/blob/main/scripts/logging.sh) that defines a standardized set of Bash logging functions. Using these functions enables consistent output formatting and allows the Runbooks UI to parse log levels for filtering and export.

#### Log Levels

| Function | Output | Description |
|----------|--------|-------------|
| `log_info "msg"` | `[timestamp] [INFO]  msg` | General informational messages |
| `log_warn "msg"` | `[timestamp] [WARN]  msg` | Warning conditions |
| `log_error "msg"` | `[timestamp] [ERROR] msg` | Error messages |
| `log_debug "msg"` | `[timestamp] [DEBUG] msg` | Debug output (only when `DEBUG=true`) |

#### Usage Example

```bash
#!/bin/bash
log_info "Starting validation..."
log_debug "Checking environment variable: $MY_VAR"

if [ -z "$MY_VAR" ]; then
  log_warn "MY_VAR is not set, using default"
fi

if ! command -v aws &>/dev/null; then
  log_error "AWS CLI is not installed"
  exit 1
fi

log_info "Validation complete"
```

#### Local Development

When running scripts locally (outside the Runbooks UI), the logging function won't magically be pre-loaded, so if you'd like your scripts to run successfully both locally and in the Runbooks enviroment, copy/paste this snippet to the top of your script:

```bash
# --- Runbooks Logging (https://runbooks.gruntwork.io/authoring/blocks/check#logging) ---
if ! type log_info &>/dev/null; then
  source <(curl -fsSL https://raw.githubusercontent.com/gruntwork-io/runbooks/main/scripts/logging.sh 2>/dev/null) 2>/dev/null
  type log_info &>/dev/null || { log_info() { echo "[INFO]  $*"; }; log_warn() { echo "[WARN]  $*"; }; log_error() { echo "[ERROR] $*"; }; log_debug() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG] $*"; }; }
fi
# --- End Runbooks Logging ---
```

This snippet checks if the logging functions are already defined, attempts to fetch them from GitHub, and falls back to simple implementations if offline.

### With Variables

There are several ways to collect variables to customize a check's command or script.

#### Using inputsId

The Check command or script pulls its values from a separate Inputs block.

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

#### Using Inline Inputs

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

#### Using Multiple inputsIds

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

### Execution Context

Scripts run in a **non-interactive shell**, which means shell aliases (like `ll`) and shell functions (like `nvm`, `rvm`) are **not available**. Environment variables are inherited from the process that launched Runbooks.

For full details, see [Shell Execution Context](/security/shell-execution-context/).

### Examples

Let's take a look at some example scripts:

#### Basic Validation Script

```bash
#!/bin/bash
# checks/terraform-installed.sh

log_info "Checking for OpenTofu installation..."

if command -v tofu &> /dev/null; then
    log_info "OpenTofu is installed: $(tofu version | head -1)"
    exit 0
else
    log_error "OpenTofu is not installed"
    exit 1
fi
```

#### Script with Warning

```bash
#!/bin/bash
# checks/disk-space.sh

log_info "Checking available disk space..."
available=$(df -h / | awk 'NR==2 {print $4}' | sed 's/G//')
log_debug "Available space: ${available}GB"

if [ "$available" -lt 1 ]; then
    log_error "Less than 1GB available"
    exit 1
elif [ "$available" -lt 5 ]; then
    log_warn "Less than 5GB available"
    exit 2
else
    log_info "Disk space OK: ${available}GB available"
    exit 0
fi
```

#### Parameterized Script

```bash
#!/bin/bash
# checks/s3-bucket-exists.sh

BUCKET_NAME="{{ .BucketName }}"

log_info "Checking if S3 bucket exists..."
log_debug "Bucket name: ${BUCKET_NAME}"

if aws s3 ls "s3://${BUCKET_NAME}" &> /dev/null; then
    log_info "Bucket ${BUCKET_NAME} exists"
    exit 0
else
    log_error "Bucket ${BUCKET_NAME} does not exist"
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
