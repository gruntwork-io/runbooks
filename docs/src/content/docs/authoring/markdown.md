---
title: Markdown Support
---

# Markdown in Runbooks

Runbooks use **GitHub-flavored Markdown** (GFM) with full support for common markdown elements.

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

## MDX Features

Since runbooks use MDX, you can also:

### Import and Use React Components

The special blocks (`<Check>`, `<Command>`, etc.) are React components that are automatically available without imports.

### Mix Markdown and JSX

```mdx
# My Runbook

Regular markdown text here.

<Admonition type="info" title="Note" description="This is a React component!" />

More markdown text.
```

### Use JavaScript Expressions

```mdx
Today's date: {new Date().toLocaleDateString()}
```

## Special Considerations

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

### HTML

You can use HTML directly in markdown:

```markdown
<div style="color: red;">
This text will be red.
</div>
```

## Rendering

The runbook frontend uses:
- **react-markdown** for parsing markdown
- **remark-gfm** for GitHub-flavored markdown features
- **rehype-highlight** for syntax highlighting
- Custom React components for special blocks

This ensures consistent rendering across different browsers and platforms.
