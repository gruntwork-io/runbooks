---
title: Runbooks vs. Other Tools
sidebar:
  order: 4
---

## Runbooks vs. Static Documentation

**Static Documentation (Markdown, Wiki pages, etc.)**

- ✅ Easy to write and maintain
- ✅ Can be version controlled
- ❌ Quickly becomes outdated
- ❌ No validation that examples actually work
- ❌ Users must manually copy/paste and customize

**Runbooks**

- ✅ Interactive and executable
- ✅ Examples are always current because they actually run
- ✅ Automatically customized to user's needs via forms
- ✅ Can validate prerequisites and outcomes
- ✅ Still easy to write (just markdown with special blocks)

**When to use which**: Use static documentation for reference material and concepts. Use Runbooks for procedures, tutorials, and anything that involves executing commands or generating code.

## Runbooks vs. Code Examples

**Static Code Examples**

- ✅ Show how to use an API or tool
- ❌ Often incomplete (missing context, prerequisites)
- ❌ Users must manually adapt to their situation
- ❌ No way to verify they work in user's environment

**Runbooks**

- ✅ Provide complete, working examples
- ✅ Include prerequisites and validation
- ✅ Automatically adapt to user's inputs
- ✅ Can execute and verify results
- ✅ Generate customized code on demand

**When to use which**: Include code examples in your documentation. Use Runbooks when you want users to actually execute or generate code.

## Runbooks vs. Jupyter Notebooks

**Jupyter Notebooks**

- ✅ Excellent for data science and analysis
- ✅ Mix documentation with executable code
- ✅ Show output inline
- ❌ Python/R focused (though other kernels exist)
- ❌ Require Jupyter server setup
- ❌ Less suitable for shell commands and infrastructure tasks
- ❌ More complex to distribute and version

**Runbooks**

- ✅ Designed for DevOps and infrastructure tasks
- ✅ Native support for shell commands
- ✅ Simple file format (markdown)
- ✅ Easy to distribute (just a CLI tool)
- ✅ Integrates with Boilerplate for code generation
- ✅ Web UI automatically launches

**When to use which**: Use Jupyter for data analysis, ML experiments, and Python-heavy workflows. Use Runbooks for infrastructure provisioning, deployments, system administration, and operational procedures.

## Runbooks vs. Configuration Management Tools

**Ansible, Chef, Puppet, etc.**

- ✅ Excellent for managing infrastructure at scale
- ✅ Idempotent operations
- ✅ Powerful inventory management
- ❌ Steeper learning curve
- ❌ Primarily for infrastructure configuration, not documentation
- ❌ Not designed for interactive user input
- ❌ Overkill for simple procedures or one-off tasks

**Runbooks**

- ✅ Interactive and user-friendly
- ✅ Combines documentation with execution
- ✅ Great for one-off procedures and tutorials
- ✅ Flexible - run anything via shell commands
- ❌ Not designed for managing large infrastructure fleets
- ❌ No built-in idempotency guarantees

**When to use which**: Use configuration management tools to manage production infrastructure. Use Runbooks to document procedures, onboard users, generate code, and execute ad-hoc tasks.

## Runbooks vs. CI/CD Pipelines

**CI/CD (GitHub Actions, GitLab CI, Jenkins, etc.)**

- ✅ Automated execution on triggers (commits, schedules, etc.)
- ✅ Designed for production workflows
- ✅ Excellent for testing and deployment
- ❌ Not designed for interactive use
- ❌ Limited user input options
- ❌ Not suitable for documentation

**Runbooks**

- ✅ Interactive and user-guided
- ✅ Rich documentation alongside execution
- ✅ Dynamic forms for user input
- ✅ Great for learning and one-off operations
- ❌ Not designed for automated/scheduled execution
- ❌ Requires user interaction

**When to use which**: Use CI/CD for automated testing and deployment. Use Runbooks for procedures that require human decision-making, learning, or customization.

## Runbooks vs. Shell Scripts

**Shell Scripts**

- ✅ Fast to write for simple tasks
- ✅ Portable and widely understood
- ❌ Limited user interaction (just command-line args)
- ❌ No documentation inline (or just comments)
- ❌ No validation of prerequisites
- ❌ No rich UI

**Runbooks**

- ✅ Rich documentation integrated with execution
- ✅ Web forms for user input with validation
- ✅ Can still run shell scripts when needed
- ✅ Prerequisites checking built-in
- ✅ Better error messages and user guidance

**When to use which**: Use shell scripts as building blocks. Use Runbooks to orchestrate scripts, provide documentation, collect user input, and guide users through multi-step procedures.

