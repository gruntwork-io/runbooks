---
title: Markdown Support
---

Runbooks renders GitHub-flavored Markdown (GFM).

## Supported elements

### Headers

```markdown
# Header 1
## Header 2
### Header 3
#### Header 4
##### Header 5
###### Header 6
```

### Text formatting

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

Image paths must start with `./assets/`. Runbooks loads them from the `assets/` folder next to your runbook file. Any other relative path, such as `images/diagram.png` or `assets/diagram.png` without the leading `./`, won't load. To set an image's size, use an `<img>` tag with the same kind of path, for example `<img src="./assets/image.png" width="400" />`. See [Relative paths](/authoring/runbook-structure/#relative-paths) for video and audio.

### Code blocks

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

Supported languages include bash, sh, shell, python, javascript, typescript, go, rust, java, terraform, hcl, yaml and json.

### Blockquotes

```markdown
> This is a blockquote.
> It can span multiple lines.
>
> And have multiple paragraphs.
```

### Horizontal rules

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

## MDX features

MDX adds a few things on top of markdown.

### Mix markdown and JSX

```mdx
# My Runbook

Regular markdown text here.

<Admonition type="info" title="Note" description="This is a React component!" />

More markdown text.
```

### Literal values in props

Use `{...}` to pass a prop value that isn't a plain string, such as a number, a boolean, an array or an object:

```mdx
<Command id="build" command="make build" timeoutMs={300000} />

<AwsAuth id="prod-auth" detectCredentials={[{ env: { prefix: 'PROD_' } }, 'env']} />
```

Runbooks never runs JavaScript from your `runbook.mdx`. The value inside `{...}` must be a literal: a string, number, boolean or `null`, a template string without `${...}` substitutions, or an array or object made only of those. You can also write `{/* comments */}`. `import` and `export` statements, JavaScript expressions such as `{new Date().toLocaleDateString()}`, and spread props such as `{...props}` are rejected with an error when the runbook opens. See the [execution security model](/security/execution-model/) for why.

### HTML

You can use HTML directly in markdown:

```markdown
<div style="color: red;">
This text will be red.
</div>
```

Because Runbooks never runs JavaScript from your `runbook.mdx`, elements and props that load scripts, embed other documents or inject raw HTML are rejected with an error. These include `<script>`, `<iframe>`, `<object>`, `<embed>`, custom elements such as `<my-widget>`, namespaced elements such as `<svg:script>`, `dangerouslySetInnerHTML`, `srcDoc` and `javascript:` URLs in props. See the [execution security model](/security/execution-model/) for the full list.

### Escaping special characters

To display a markdown character literally, escape it with a backslash:

```markdown
\* This won't be italic
\# This won't be a header
\`This won't be code\`
```

### Code blocks inside blocks

Blocks such as `<Inputs>` take a fenced code block as their content:

````mdx
<Inputs id="my-form">
```yaml
variables:
  - name: Example
    type: string
```
</Inputs>
````

To show a fenced block inside another fenced block, as this page does, give the outer fence more backticks than the inner one. Do not escape the inner backticks.

