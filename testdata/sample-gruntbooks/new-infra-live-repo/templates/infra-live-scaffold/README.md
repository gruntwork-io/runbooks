# {{ .RepoName }}

This repository contains the Terragrunt configurations that define the infrastructure deployed across all AWS accounts and regions. It follows the [Gruntwork infrastructure-live](https://github.com/gruntwork-io/terragrunt-infrastructure-live-stacks-example) pattern.

## Folder Hierarchy

```
{{ .RepoName }}/
├── root.hcl                      # Root Terragrunt configuration (provider, backend, catalog)
├── mise.toml                     # Pinned tool versions (OpenTofu, Terragrunt)
├── <account-name>/               # One folder per AWS account (e.g., dev, staging, prod)
│   ├── account.hcl               # Account-level variables (account name, account ID)
│   └── <region>/                 # One folder per AWS region (e.g., us-east-1, eu-west-1)
│       ├── region.hcl            # Region-level variables (aws_region)
│       └── <module-name>/        # One folder per deployed module instance
│           └── terragrunt.hcl    # Terragrunt unit that sources a module from infra-catalog
```

### Key Concepts

- **Account folders** represent AWS accounts. Each contains an `account.hcl` with the account name and AWS account ID.
- **Region folders** represent AWS regions within an account. Each contains a `region.hcl` with the region name.
- **Module folders** represent a single deployed instance of an OpenTofu module. Each contains a `terragrunt.hcl` that sources the module from an infra-catalog repo and provides input values.

### Configuration Files

| File | Purpose |
|------|---------|
| `root.hcl` | Shared Terragrunt config inherited by all units. Configures the AWS provider, S3 remote state backend, and catalog URLs. |
| `account.hcl` | Sets `account_name` and `aws_account_id` for all units in the account. |
| `region.hcl` | Sets `aws_region` for all units in the region. |
| `terragrunt.hcl` | Defines a single infrastructure unit: which module to deploy and what inputs to pass. |

### Adding a New Account

1. Create a new folder at the repo root (e.g., `staging/`)
2. Add an `account.hcl`:
   ```hcl
   locals {
     account_name   = "staging"
     aws_account_id = get_env("STAGING_ACCOUNT_ID")
   }
   ```
3. Create region folders as needed (e.g., `staging/{{ .DefaultRegion }}/region.hcl`)

### Adding a New Module Instance

1. Navigate to the appropriate `<account>/<region>/` folder
2. Create a new folder named after the module (e.g., `vpc/`)
3. Add a `terragrunt.hcl` that sources the module and provides inputs

## Getting Started

1. Install tools: `mise install`
2. Set your AWS account ID environment variables
3. Configure AWS credentials (e.g., via `aws sso login` or `assume`)
4. Run `terragrunt plan` in any module folder to preview changes
