---
title: Use Cases
sidebar:
  order: 3
---

# Use Cases

## Developer Self-Service

Enable developers to perform complex operations without deep expertise:

- **Onboarding new projects**: Runbooks guide developers through setting up new services with all the right configurations
- **Infrastructure provisioning**: Generate and deploy infrastructure-as-code with validated inputs
- **Tool installation**: Check for prerequisites and guide installation of required tools

Example: A runbook that creates a new microservice with proper AWS infrastructure, CI/CD pipelines, and monitoring configuration.

## Streamlining Internal Processes

Document and automate repetitive operational procedures:

- **Incident response**: Step-by-step runbooks for handling common incidents with automated remediation scripts
- **Deployment procedures**: Standardized deployment processes with safety checks
- **Environment setup**: Automated setup of development, staging, and production environments

Example: A runbook for deploying a new version of your application that checks prerequisites, backs up data, performs the deployment, and validates the results.

## Documenting Infrastructure-as-Code Modules

Make your IaC modules more accessible with interactive documentation:

- **Module usage examples**: Show how to use Terraform/OpenTofu modules with real, working examples
- **Configuration generation**: Let users fill out forms to generate properly configured module calls
- **Testing**: Include checks that validate the module works as expected

Example: A runbook that documents your VPC Terraform module, generates a customized configuration based on user inputs, and validates the VPC was created correctly.

## Testing Infrastructure-as-Code Modules

Create interactive test suites for your infrastructure modules:

- **Integration tests**: Runbooks that deploy, test, and teardown infrastructure
- **Validation checks**: Verify infrastructure meets requirements
- **Documentation of test results**: Capture and display test outputs

Example: A runbook that deploys an RDS instance using your Terraform module, validates connectivity and configuration, runs performance tests, and cleans up resources.

## Automatically Updated Long-Form Guides

Create guides that stay current with your infrastructure:

- **Onboarding documentation**: Guides that actually work because they execute real commands
- **Troubleshooting guides**: Diagnostic runbooks that check system state and suggest fixes
- **Best practices**: Codified knowledge that can be executed, not just read

Example: A comprehensive AWS multi-account setup guide that creates accounts, configures IAM, sets up networking, and validates everything along the way.

## Training and Knowledge Transfer

Capture expert knowledge in an executable format:

- **New hire training**: Interactive tutorials that teach while doing
- **Cross-training**: Help team members learn new areas with guided exercises
- **Knowledge preservation**: Document complex procedures before experts leave

Example: A runbook series that teaches Kubernetes concepts while actually deploying and configuring a cluster.

