---
title: Gruntbooks vs. Other
sidebar:
  order: 7
---

## vs. Static documentation

Static documentation is often hosted in services like Notion, Confluence, or directly in git repos (e.g. on GitHub or GitLab). It's easy to write, but can quickly get out of date, lacks automated validation, and requires users to manually copy/paste and adapt the code samples to their unique needs.

For consumers, Gruntbooks can generate the files they need based on custom user inputs entered from a web form, execute arbitrary commands to automate other steps, and give built-in validation checks so users can "do a thing, then check a thing." In short, Gruntbooks can streamline the "full experience" for consumers, not just a small part of it.

For authors, writing gruntbooks is just as easy as writing documentation because you author a gruntbook by writing a file in MDX, which is markdown plus a limited number of special components, which Gruntbooks calls [blocks](/authoring/blocks). 

Gruntbooks also gives authors an opportunity for fast feedback loops. When users are frustrated by static documentation, they often suffer silently. But the nature of Gruntbooks enables users to give specific feedback about a missing check, missing command, or missing input value for templates. Authors can iteratively incorporate this feedback so that a Gruntbook can gradually grow to reflect the accumulated body of experience of all its consumers, leaving the next Gruntbook consumer with a surprisingly streamlined experience.

Finally, because Gruntbooks can generate arbitrary code, Gruntbook authors can even produce automated tests along with the "consumable" code to validate that the Gruntbook works as expected.

## vs. Internal developer portals

Internal Developer Portals (IDPs) like [Backstage](https://backstage.io/) and [Port](https://www.getport.io/) provide a unified interface for developers and typically include service catalogs, software templates, API documentation, and dashboards that give visibility into the entire engineering ecosystem.

One popular use case for IDPs is template generation. For example, Backstage uses the Scaffolder plugin to enable templates that uses the Nunjucks templating language. Backstage presents users with a nice catalog of templates to choose from, however the templating experience itself suffers from several shortcomings.

For end users, they cannot preview the code they will generate in real time, they cannot easily validate that the template they generated performed as expected, and any documentation associated with the template is typically generated as code rather than being part of the experience. 

For template authors, the authoring experience can be challenging, requiring repeated runs of the same template and wrestling with unique Backstage configuration issues. In addition, Backstage itself is non-trivial to both setup and maintain.

By contrast, Gruntbooks offers a self-contained first-class templating experience for both end users and template authors. For consumers, they install gruntbooks from GitHub and run `gruntbooks open /path/to/gruntbook` (or `gruntbooks open https://github.com/org/repo/tree/main/path/to/gruntbook` for a remote URL) and can instantly read rich documentation, see the files they will generate in real-time, run a customized set of commands, and validate that everything is working correctly.

For authors, there is nothing to configure. You download the `gruntbooks` binary and author a Gruntbook by writing a `gruntbook.mdx` file, and seeing real-time changes with `gruntbooks watch /path/to/gruntbook`. Authors can test template generation locally using the Gruntbooks tool itself, or for even more control over the feedback loop, authors can opt to directly use the [Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate) templating engine. As a result, authors have real-time feedback loops on everything they create.

## Vs. Jupyter Notebooks

Jupyter notebooks are interactive computational documents that combine live code, visualizations, narrative text, and equations in a single environment. They follow a "literate programming" paradigm where documentation and code coexist, making them ideal for data analysis, scientific computing, education, and reproducible research.

Jupyter Notebooks are oriented heavily around IPython, an extension of standard Python, where they maintain a "Python program state" as you work.

Gruntbooks also combine both code and documentation in a single environment, however there are a few key differences compared to Jupyter Notebooks:

1. **Author-Focused vs Consumer-Focused**: Jupyter Notebooks are optimized for the author, with a special focus on giving authors a useful "canvas" to incrementally evolve program state and produce artifacts. They are especially well suited to enabling notebook authors to "show their work."

   By contrast, Gruntbooks is focused more on the _consumer_ of the Gruntbook than the author. In the Gruntbooks way of thinking, authors are not "exploring ideas," but codifying their knowledge and insights around a specific DevOps pattern. Gruntbook consumers then get a first-class experience learning and applying this pattern for their needs.

   Moreover, running a Jupyter Notebook is not straightforward for those who do it only periodically. By contrast, Gruntbooks can be opened by downloading the gruntbooks binary and running `gruntbooks open /path/to/gruntbook` or pointing it at a remote URL like `gruntbooks open https://github.com/org/repo/tree/main/gruntbooks/my-gruntbook`.

2. **Internal Program State vs External Artifacts**: With each "cell" in a Jupyter Notebook, the notebook author evolves the state of a Python program.

   By contrast, with each block in a Gruntbook, the Gruntbook consumer is making progress against their use case and generating the artifacts of generated files, updated external state (by running commands), and personal confidence that they are succeeding.
   
   In other words, for Jupyter Notebooks, the "artifact" is updates to an internal program, whereas for Gruntbooks, the artifact is files, external state changes, and end user confidence.

2. **Optimized for power vs UX**: Jupyter Notebooks are powerful environments that can execute arbitrary code, generate charts, and allow authors to trace back execution history and restart execution. 

   By contrast, Gruntbooks offers a less powerful canvas for code execution. For example, Gruntbooks does not support a concept of "program state" that can be passed down to subsequent blocks. However, Gruntbooks offers a more streamlined file generation experience, making it simple for Gruntbook consumers to enter values in a web form to generate custom files, run custom commands, or run custom checks.

   In short, Gruntbooks trades power for a more streamlined UX on a more narrow set of highly important capabilities. As a result, any Gruntbook _could_ be written as a Jupyter Notebook, but the authorship experience would be more clumsy, and the end user experience would be more confusing.