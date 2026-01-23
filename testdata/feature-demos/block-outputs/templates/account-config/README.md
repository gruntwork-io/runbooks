# Account Config Template

This template demonstrates using block outputs in a Template block.

## Output Dependencies

The account.tf file references outputs from the create-account Command block:

- account_id - The AWS account ID
- region - The AWS region

## How It Works

1. When this Template loads, Runbooks scans the template files for block output patterns
2. These are registered as output dependencies
3. The Template shows a warning and disables the Generate button until those outputs exist
4. Once the create-account Command runs and produces outputs, this Template can be generated

## Variables

This template also accepts its own variables via the form:

- config_name - Name for the configuration
- description - Description of the configuration

These are combined with the block outputs when rendering the template.
