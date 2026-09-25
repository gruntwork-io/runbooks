---
title: Markdown Support
---

# Markdown in Runbooks

Runbooks uses **GitHub-flavored Markdown** (GFM) with full support for common markdown elements. That means you can include any of the following elements in your runbooks.

## Supported Elements

### Headers

```markdown
# Header 1
## Header 2
### Header 3
#### Header 4
##### Header 5
###### Header 6
```

### Text Formatting

```markdown
**Bold text**
*Italic text*
***Bold and italic***
~~Strikethrough~~
`Inline code`
```

### Lists

Unordered lists:
```markdown
- Item 1
- Item 2
  - Nested item
  - Another nested item
- Item 3
```

Ordered lists:
```markdown
1. First item
2. Second item
3. Third item
   1. Nested numbered item
```

Task lists:
```markdown
- [x] Completed task
- [ ] Incomplete task
- [ ] Another task
```

### Links

```markdown
[Link text](https://example.com)
[Link with title](https://example.com "Title text")
```

### Autolinks

URLs and email addresses are automatically converted to clickable links:

```markdown
Visit https://gruntwork.io for more info.
Contact support@example.com for help.
```

### Images

```markdown
![Alt text](./assets/image.png)
![Image with title](./assets/image.png "Image title")
```

Images are resolved relative to the runbook file location.

### Code Blocks

Inline code:
```markdown
Use the `npm install` command to install dependencies.
```

Code blocks with syntax highlighting:
````markdown
```bash
echo "Hello, world!"
```

```python
def hello():
    print("Hello, world!")
```

```javascript
console.log("Hello, world!");
```
````

Supported languages include: bash, sh, shell, python, javascript, typescript, go, rust, java, terraform, hcl, yaml, json, and many more.

### Blockquotes

```markdown
> This is a blockquote.
> It can span multiple lines.
>
> And have multiple paragraphs.
```

### Horizontal Rules

```markdown
---
***
___
```

### Tables

```markdown
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
```

With alignment:
```markdown
| Left-aligned | Center-aligned | Right-aligned |
|:-------------|:--------------:|--------------:|
| Left         | Center         | Right         |
```

### Footnotes

```markdown
Here is a sentence with a footnote.[^1]

[^1]: This is the footnote content.
```

Footnotes are collected and rendered at the bottom of the document.

## MDX Features

Because Runbooks supports MDX, you also have access to a few special features beyond standard markdown elements.

### Mix Markdown and JSX

```mdx
# My Runbook

Regular markdown text here.

<Admonition type="info" title="Note" description="This is a React component!" />

More markdown text.
```

### Use Literal Values in Props

Use `{...}` to pass a prop value that isn't a plain string, such as a boolean, a number, an array or an object:

```mdx
<Command id="build" command="make build" usePty={false} />

<AwsAuth id="prod-auth" detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />
```

Runbooks never runs JavaScript from your `runbook.mdx`. The value inside `{...}` must be a literal: a string, number, boolean or `null`, a template string without `${...}` substitutions, or an array or object made only of those. You can also write `{/* comments */}`. `import` and `export` statements, JavaScript expressions such as `{new Date().toLocaleDateString()}`, and spread props such as `{...props}` are rejected with an error when the runbook opens. See [Execution Security Model](/security/execution-model/) for why.

### HTML

You can use HTML directly in markdown:

```markdown
<div style="color: red;">
This text will be red.
</div>
```

Because Runbooks never runs JavaScript from your `runbook.mdx`, elements and props that load scripts, embed other documents or inject raw HTML are rejected with an error. These include `<script>`, `<iframe>`, `<object>`, `<embed>`, custom elements such as `<my-widget>`, `dangerouslySetInnerHTML` and `srcDoc`. See [Execution Security Model](/security/execution-model/) for the full list.

### Escaping Special Characters

If you need to display special characters literally, escape them with a backslash:

```markdown
\* This won't be italic
\# This won't be a header
\`This won't be code\`
```

### Code Blocks in Special Blocks

When embedding YAML or other code in special blocks, use proper fencing:

```mdx
<BoilerplateInputs id="my-form">
```yaml
variables:
  - name: Example
    type: string
\```
</BoilerplateInputs>
```

Note: Use a backslash before the closing triple backticks to escape them within the outer code block.

