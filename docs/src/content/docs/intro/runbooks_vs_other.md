---
title: Runbooks vs. Other
sidebar:
  order: 5
---

## Runbooks vs. Static Documentation

Static documentation is easy to write, but quickly becomes out of date, lacks automated validation, and requires users to manually copy/paste and adapt the documentation to their needs.

Runbooks are also easy to write, but can generate their own automated tests to support automated testing, have built-in validation checks that allow users to "do a thing, then check a thing," and can generate files based on custom user inputs.

## Runbooks vs. Code Examples

Traditional code examples live in the same repo as the code base they show an example of and are able to be tested along with the code, but the documentation is often out of date or missing, and users must manually figure out how to adapt th example to their situation, and verify usage.

Runbooks intends to combine documentation and examples into a single document that allows first-class customizability by the user, and supports first-class validation.

## Runbooks vs. Jupyter Notebooks

Jupyter notebooks are interactive computational documents that combine live code, visualizations, narrative text, and equations in a single environment. They follow a "literate programming" paradigm where documentation and code coexist, making them ideal for data analysis, scientific computing, education, and reproducible research.

Jupyter Notebooks are oriented heavily around Python where they maintain a "Python program state" as you work.

Runbooks also combine both code and documentation in a single environment, however there are several key differences compared to Jupyter Notebooks:

1. **Author-Focused vs Consumer-Focused**: Jupyter Notebooks are optimized for the author persona, with a special focus on giving authors a useful "canvas" to incrementally evolve program state and produce artifacts. You could say they are especially useful at helping notebook authors "show their work."

   By contrast, Runbooks are focused more on the _consumer_ of the Runbook than the author. In the Runbooks way of thinking, authors are not "exploring ideas," but codifying their knowledge and insights around a specific DevOps pattern. Runbook consumers then get a first-class experience learning and applying this pattern for their needs.

2. **Arbitrary Execution vs Targeted File Generation**: Jupyter Notebooks are powerful environments that can execute arbitrary code, generate charts, and allow authors to trace back execution history and restart execution. 

   By contrast, Runbooks are less powerful but more targeted. Runbooks treat file generation as a first-class concept, making it easy to expose a custom webform to allow users to configure their files, offering deep integration with [Gruntwork Boilerplate](https://github.com/gruntwork-io/boilerplate), and including a handy UI where users can see and copy all the generated files.

3. **Internal Program State vs External Artifacts**: With each "cell" in a Jupyter Notebook, the notebook author evolves the state of a Python program.

   By contrast, with each block in a Runbook, the consumer is working their way towards either file generation, an arbitrary operation, or validation. In other words, the artifact is files and external state changes, not updates to an internal program.
