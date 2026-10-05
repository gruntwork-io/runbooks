---
title: Overview
---

A runbook combines markdown with interactive blocks that:

- Validate the user's current state with automated checks
- Execute shell commands and scripts
- Collect user input through forms
- Generate files from templates

All of this runs locally on the user's machine in the Runbooks desktop app.

## Quick start

For a complete tutorial, see [Write your first runbook](/intro/write_your_first_runbook/).

## Section guide

- [Runbook structure](/authoring/runbook-structure/) covers the file format and folder layout.
- [Markdown](/authoring/markdown/) is the reference for supported markdown elements.
- [Inputs and outputs](/authoring/inputs-and-outputs/) explains how data flows between blocks: collecting user input, wiring it with `inputsId`, and passing runtime outputs to later blocks.
- [Boilerplate templates](/authoring/boilerplate/) covers template syntax and `boilerplate.yml` files.
- [Blocks](/authoring/blocks/) is the reference for every interactive block.
- [Opening runbooks](/authoring/opening-runbooks/) covers the ways to open a runbook, locally or from a remote URL.
- [Testing](/authoring/testing/) covers `runbook_test.yml` and the test CLI.
