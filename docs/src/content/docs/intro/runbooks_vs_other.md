---
title: Runbooks vs. other tools
sidebar:
  order: 7
---

## vs. static documentation

Static documentation in Notion, Confluence, or a git repo is easy to write. It also goes out of date, has no automated validation, and leaves users to copy, paste, and adapt its code samples.

A runbook generates the files a consumer needs from values they enter in a form, runs commands for the other steps, and runs checks so the consumer can confirm each step worked.

Authors write a runbook as an MDX file, which is markdown plus a small set of components that Runbooks calls [blocks](/authoring/blocks/).

Consumers can report a missing check, command, or template input, and the author can add it to the runbook for the next consumer. A runbook can also generate automated tests alongside the code it produces.

## vs. internal developer portals

Internal developer portals (IDPs) like [Backstage](https://backstage.io/) and [Port](https://www.getport.io/) give developers one interface for service catalogs, software templates, API documentation, and dashboards.

One popular use for IDPs is template generation. Backstage, for example, uses the Scaffolder plugin for templates written in the Nunjucks templating language. It presents users with a catalog of templates to choose from, but the templating has shortcomings.

End users cannot preview the code they will generate as they fill in values, and cannot easily validate that what they generated works. Any documentation for the template is typically generated as code, separate from the form the user fills in.

Template authors have to run the same template repeatedly and work through Backstage configuration issues. Backstage itself takes real effort to set up and maintain.

With Runbooks, a consumer installs the desktop app and runs `runbooks open /path/to/runbook`, or `runbooks open https://github.com/org/repo/tree/main/path/to/runbook` for a remote runbook. In one window they read the documentation, see the files they will generate as they type, run commands, and run checks.

An author installs the same app, writes a `runbook.mdx` file, and sees each save reloaded with `runbooks open --watch /path/to/runbook`. Authors can test template generation in Runbooks, or run the [Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate) templating engine directly.

## vs. Jupyter notebooks

Jupyter notebooks and runbooks both combine code and documentation in one document. They differ in who the document is for, what each step produces, and how much the document can do.

### Who the document is for

A Jupyter notebook is optimized for its author, who uses it as a canvas to evolve program state step by step and show their work.

A runbook is optimized for its consumer. The author writes down what they know about a specific DevOps pattern, and the consumer applies it.

Running a notebook means setting up Python and Jupyter first. Opening a runbook takes the desktop app and one command, `runbooks open /path/to/runbook`, or the same command with a remote URL such as `runbooks open https://github.com/org/repo/tree/main/runbooks/my-runbook`.

### What each step produces

Each cell in a Jupyter notebook changes the state of a Python program.

Each block in a runbook produces something outside the document: generated files, changes made by commands, and checks that confirm the step worked.

### How much the document can do

Jupyter notebooks can execute arbitrary code, draw charts, and let authors trace back and restart execution.

Runbooks does less. Blocks pass environment variables and named outputs to later blocks, but no in-memory program state. In exchange, a consumer fills in a form to generate files, run commands, or run checks.
