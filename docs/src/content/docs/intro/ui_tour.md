---
title: UI Tour
sidebar:
   order: 4
---

Let's see what a **Runbook consumer** would see when they `runbooks open` the `my-first-runbook` we created in the previous page.

![Runbook UI Screenshot 1](/runbooks_demo_1.png)

You'll notice that the first portion of the Runbook renders just like a GitHub README. Once we get to the "Prerequisites" message, we see are first [block](/authoring/blocks), the `<Admonition>`. Let's scroll down a little further.

![Runbook UI Screenshot 2](/runbooks_demo_2.png)

Here we see our second block, the `<Check>`, in this case one that's checking the local version of `git`. 

![Runbook UI Screenshot 3](/runbooks_demo_3.png)

When we press the "Check" button, we can see that the `<Check>` shows us the execution logs and the success status of the command (in this case, a positive status!).

![Runbook UI Screenshot 4](/runbooks_demo_4.png)

Now we've come to our first `<BoilerplateInputs>` block, which exposes a web form. Runbook web forms are dynamically generated based on the contents of the Boilerplate variables, which in this case were:

```yaml
variables:
  - name: Name
    type: string
    description: What's your name?
    validations: "required"
  - name: FavoriteLanguage
    type: enum
    description: What's your favorite programming language?
    options:
      - Go
      - Python
      - JavaScript
      - Rust
      - Other
    default: Go
```

Now let's fill out some values, click "Generate" and see what happens.

![Runbook UI Screenshot 5](/runbooks_demo_5.png)

It looks like that `<Command>` block automatically updated its script based on these values!

![Runbook UI Screenshot 6](/runbooks_demo_6.png)

Finally, we can "Run" the command and see the result.

## Additional UI

The example `my-first-runbook` Runbook didn't include any explicit file generation, but here's an example of what that looks like:

![Runbook UI Screenshot 7](/runbooks_demo_7.png)

Note that as you type in the inputs, the file contents automatically update.

## Next

Now that you understand how Runbooks work, let's learn about how this collection of functionality is useful in practical real-world scenarios.
