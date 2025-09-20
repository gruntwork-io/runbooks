import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import ReactMarkdown from 'react-markdown'

function App() {
  const markdownContent = `# Markdown Examples

This is a demonstration of various markdown features and syntax.

## Headers

# Level 1 Header
## Level 2 Header
### Level 3 Header
#### Level 4 Header
##### Level 5 Header
###### Level 6 Header

## Text Formatting

**Bold text** and *italic text* and ***bold italic text***

~~Strikethrough text~~

\`Inline code\` and regular text.

## Lists

### Unordered List
- Item 1
- Item 2
  - Nested item 2.1
  - Nested item 2.2
- Item 3

### Ordered List
1. First item
2. Second item
   1. Nested numbered item
   2. Another nested item
3. Third item

## Code Blocks

\`\`\`go
func main() {
    fmt.Println("Hello, World!")
}
\`\`\`

\`\`\`python
def hello_world():
    print("Hello, World!")
\`\`\`

## Links and Images

[Link to Google](https://www.google.com)

![Alt text for image](https://via.placeholder.com/150)

## Tables

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Row 1    | Data 1   | Data 2   |
| Row 2    | Data 3   | Data 4   |
| Row 3    | Data 5   | Data 6   |

## Blockquotes

> This is a blockquote.
> 
> It can span multiple lines.
> 
> > And can be nested!

## Horizontal Rule

---

## Task Lists

- [x] Completed task
- [ ] Incomplete task
- [x] Another completed task
- [ ] Another incomplete task

## Escaped Characters

\\*This text has asterisks\\* but they won't be interpreted as markdown.

## Line Breaks

This is line 1.  
This is line 2 with two spaces at the end.

This is line 3 with a blank line above.

## Emphasis Combinations

**Bold with *italic* inside**

*Italic with **bold** inside*

***Bold italic text***

## Code and Emphasis

\`**Bold text inside code**\` - this won't be bold

**\`Code inside bold\`** - this will be both bold and code formatted`;

  return (
    <>
      <div className="flex flex-col items-center justify-center pt-8">
        <h1>Gruntwork Runbooks</h1>
        <p>This is a placeholder for the runbook consumer.</p>
        <div className="mt-8 max-w-4xl mb-8">
          <div className="markdown-body p-8 border border-gray-200 rounded-lg box-shadow-md">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
          </div>
        </div>
      </div>
    </>
  )
}

export default App