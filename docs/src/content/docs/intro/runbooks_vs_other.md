---
title: Runbooks vs. Other
sidebar:
  order: 6
---

## vs. Static documentation

Static documentation is often hosted in services like Notion, Confluence, or directly in git repos (e.g. on GitHub or GitLab). It's easy to write, but can quickly get out of date, lacks automated validation, and requires users to manually copy/paste and adapt the code samples to their unique needs.

For consumers, Runbooks can generate the files they need based on custom user inputs entered from a web form, execute arbitrary commands to automate other steps, and give built-in validation checks so users can "do a thing, then check a thing." In short, Runbooks can streamline the "full experience" for consumers, not just a small part of it.

For authors, Runbooks are just as easy to write as documentation because you author Runbooks by writing a file in MDX, which is markdown plus a limited number of special components, which Runbooks calls [blocks](/authoring/blocks). 

Runbooks also give authors an opportunity for fast feedback loops. When users are frustrated by static documentation, they often suffer silently. But the nature of Runbooks enables users to give specific feedback about a missing check, missing command, or missing input value for templates. Authors can iteratively incorporate this feedback so that a Runbook can gradually grow to reflect the accumulated body of experience of all its consumers, leaving the next Runbook consumer with a surprisingly streamlined experience.

Finally, because Runbooks can generate arbitrary code, Runbook authors can even produce automated tests along with the "consumable" code to validate that the Runbook works as expected.

## vs. Internal developer portals

Internal Developer Portals (IDPs) like [Backstage](https://backstage.io/) and [Port](https://www.getport.io/) provide a unified interface for developers and typically include service catalogs, software templates, API documentation, and dashboards that give visibility into the entire engineering ecosystem.

One popular use case for IDPs is template generation. For example, Backstage uses the Scaffolder plugin to enable templates that uses the Nunjucks templating language. Backstage presents users with a nice catalog of templates to choose from, however the templating experience itself suffers from several shortcomings.

For end users, they cannot preview the code they will generate in real time, they cannot easily validate that the template they generated performed as expected, and any documentation associated with the template is typically generated as code rather than being part of the experience. 

For template authors, the authoring experience can be challenging, requiring repeated runs of the same template and wrestling with unique Backstage configuration issues. In addition, Backstage itself is non-trivial to both setup and maintain.

By contrast, Runbooks offer a self-contained first-class templating experience for both end users and template authors. For consumers, they install runbooks from GitHub, run `runbooks open /path/to/runbook` and can instantly read rich documentation, see the files they will generate in real-time, run a customized set of commands, and validate that everything is working correctly.

For authors, there is nothing to configure. You download the `runbooks` binary and author a Runbook by writing a `runbook.mdx` file, and seeing real-time changes with `runbooks watch /path/to/runbook`. Authors can test template generation locally using the Runbooks tool itself, or for even more control over the feedback loop, authors can opt to directly use the [Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate) templating engine. As a result, authors have real-time feedback loops on everything they create.

## Vs. Jupyter Notebooks

Jupyter notebooks are interactive computational documents that combine live code, visualizations, narrative text, and equations in a single environment. They follow a "literate programming" paradigm where documentation and code coexist, making them ideal for data analysis, scientific computing, education, and reproducible research.

Jupyter Notebooks are oriented heavily around IPython, an extension of standard Python, where they maintain a "Python program state" as you work.

Runbooks also combine both code and documentation in a single environment, however there are a few key differences compared to Jupyter Notebooks:

1. **Author-Focused vs Consumer-Focused**: Jupyter Notebooks are optimized for the author, with a special focus on giving authors a useful "canvas" to incrementally evolve program state and produce artifacts. They are especially well suited to enabling notebook authors to "show their work."

   By contrast, Runbooks are focused more on the _consumer_ of the Runbook than the author. In the Runbooks way of thinking, authors are not "exploring ideas," but codifying their knowledge and insights around a specific DevOps pattern. Runbook consumers then get a first-class experience learning and applying this pattern for their needs.

   Moreover, running a Jupyter Notebook is not straightforward for those who do it only periodically. By contrast, Runbooks can be opened by downloading the runbooks binary and running `runbooks open /path/to/runbook`.

2. **Internal Program State vs External Artifacts**: With each "cell" in a Jupyter Notebook, the notebook author evolves the state of a Python program.

   By contrast, with each block in a Runbook, the Runbook consumer is making progress against their use case and generating the artifacts of generated files, updated external state (by running commands), and personal confidence that they are succeeding.
   
   In other words, for Jupyter Notebooks, the "artifact" is updates to an internal program, whereas for Runbooks, the artifact is files, external state changes, and end user confidence.

2. **Optimized for power vs UX**: Jupyter Notebooks are powerful environments that can execute arbitrary code, generate charts, and allow authors to trace back execution history and restart execution. 

   By contrast, Runbooks offer a less powerful canvas for code execution. For example, Runbooks do not support a concept of "program state" that can be passed down to subsequent blocks. However, Runbooks offers a more streamlined file generation experience, making it simple for Runbook consumers to enter values in a web form to generate custom files, run custom commands, or run custom checks.

   In short, Runbooks trades power for a more streamlined UX on a more narrow set of highly important capabilities. As a result, any Runbook _could_ be written as a Jupyter Notebook, but the authorship experience would be more clumsy, and the end user experience would be more confusing.