---
title: Authoring workflow
---

If you're writing runbooks (not developing the Runbooks tool itself), use the following the workflow:

### 1. Create Your Runbook

Create a new `runbook.mdx` file:

```bash
mkdir my-runbook
cd my-runbook
touch runbook.mdx
```

### 2. Prepare your Runbook folder structure

It can be helpful to create the standard set of folders for your Runbook so it's easy to drop files in later on. When you're done authoring your Runbook, you can delete any empty folders.

```
my-runbook/
├── runbook.mdx
├── checks/       # Validation scripts
├── scripts/      # Command scripts
├── templates/    # Boilerplate templates
└── assets/       # Images, diagrams
```

### 3. Edit Your Runbook

Open `runbook.mdx` in your favorite editor and write your content using markdown and special blocks.

AI-enabled IDEs like Cursor generally work well, and you can point them at this documentation site to teach them Runbook syntax.

### 4. Open in Runbooks

```bash
runbooks watch runbook.mdx
```

We use the `runbooks watch` command because this will automatically update the Runbook whenever there are changes to the `runbook.mdx` file, or any other files in the Runbook folder.

Your browser will open with the rendered runbook.

### 5. Iterate

Make changes to your runbook file and **refresh the browser** to see updates.

That's it! No build process or complicated setup.

## Tips for Runbook Authors

### Use Relative Paths

Always reference files relative to your runbook:

```mdx
<Check path="checks/prereq.sh" ... />
<BoilerplateInputs templatePath="templates/my-template" ... />
![Diagram](./assets/diagram.png)
```

### Use Version Control

Keep your runbooks in Git to track changes and collaborate with others.

### Start Simple

Begin with a simple runbook and add complexity gradually. Test each block as you add it.