# Gruntwork AWS Landing Zone Infrastructure Template

## Overview
This template provides Infrastructure as Code (IaC) configurations for establishing AWS Landing Zone account baselines. It manages essential resources across management, shared, logs, and security accounts, including:

- Account baseline configurations
- IAM roles and policies
- Security controls
- Cross-account access management

## Prerequisites

Before using this template, ensure you have:

1. Bootstrapped your repository using either:
   - `gitlab-pipelines-infrastructure-live-root` template
   - `devops-foundations-infrastructure-live-root` template

## Important Notes

- This template is specifically designed for AWS Landing Zone configuration
- It does not include Gruntwork Pipelines functionality
- Repository bootstrapping must be completed before executing this template

## Usage

Follow your organization's standard deployment procedures after ensuring all prerequisites are met. Refer to the associated documentation for detailed implementation guidelines.
