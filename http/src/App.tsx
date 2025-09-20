import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import ReactMarkdown from 'react-markdown'
import { useState, useEffect } from 'react'

function App() {
  const [markdownContent, setMarkdownContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/file')
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
        return response.json()
      })
      .then(data => {
        setMarkdownContent(data.content || '')
        setLoading(false)
      })
      .catch(err => {
        console.error('Error fetching file content:', err)
        setError(err.message)
        setLoading(false)
        // Fallback to static content if API fails
        setMarkdownContent(`# Error Loading Runbook

Unable to load the runbook file. Please make sure the runbooks server is running.

**Error:** ${err.message}

## Fallback Content

This is a demonstration of various markdown features and syntax.

### Headers

# Level 1 Header
## Level 2 Header
### Level 3 Header

### Text Formatting

**Bold text** and *italic text* and ***bold italic text***

~~Strikethrough text~~

\`Inline code\` and regular text.

### Code Blocks

\`\`\`go
func main() {
    fmt.Println("Hello, World!")
}
\`\`\`

### Links

[Link to Google](https://www.google.com)

### Tables

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Row 1    | Data 1   | Data 2   |
| Row 2    | Data 3   | Data 4   |

### Blockquotes

> This is a blockquote.
> 
> It can span multiple lines.`)

  return (
    <>
      <div className="flex flex-col items-center justify-center pt-8">
        <h1>Gruntwork Runbooks</h1>
        {loading ? (
          <p>Loading runbook...</p>
        ) : error ? (
          <p className="text-red-600">Error: {error}</p>
        ) : (
          <p>Runbook loaded successfully</p>
        )}
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