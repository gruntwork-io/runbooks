---
title: Overview
sidebar:
  order: 1
---

## Introduction to Runbooks

Runbooks are interactive markdown documents that allow users to read standard markdown text, generate files, run commands, and validate assertions about their local system or infrastructure.

Runbooks are designed to be authored by a subject matter expert in a given area (e.g. "How best to deploy Amazon RDS"), and consumed by users who are not a subject matter expert in that area. In other words, Runbooks are good at capturing knowledge and experience into an easily consumable artifact.

## How Runbooks Work

When you open a runbook using the `runbooks open /path/to/runbook.mdx` command, the tool launches a web interface in your default browser and renders the Runbook content. User can then interact with the Runbook by filling out forms, generating files, running command, and running checks.

## Key Features

### Markdown + Special Blocks

Write your runbooks in markdown (or MDX) and enhance them with special blocks like `<Check>`, `<Command>`, `<BoilerplateInputs>`, and `<Admonition>` for interactive functionality.

### Dynamic Web Forms

Runbooks render dynamic web forms based on the runbook contents or code generation templates. Users fill out these forms to customize commands, checks, and code generation exactly to their needs.

### Code Generation with Boilerplate

Runbooks integrate with [Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate) to generate customized code from templates. Define variables in YAML, and users can fill out forms to generate infrastructure-as-code, configuration files, or any templated content.

### Interactive Commands

Execute shell commands directly from the runbook interface with customizable parameters using Go template syntax. Commands can reference variables from Boilerplate forms.

### System Checks

Validate pre-flight checks and post-flight checks by running shell scripts that return success, warning, or failure status codes. Checks help ensure users have the required tools installed and their environment is properly configured.

