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
    fetch('http://localhost:7825/api/file')
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
      })
  })

  return (
    <>
      <div className="flex flex-col items-center justify-center">
        
        <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold">
          Gruntwork Runbooks
        </header>
        
        <div className="text-center mt-8 text-gray-500">
        {loading ? (
          <p>Loading runbook...</p>
        ) : error ? (
          <p className="text-red-600">Error: {error}</p>
        ) : null}
        </div>

        <div className="m-8 flex gap-8">

          {/* Markdown content */}
          <div className="markdown-body flex-1 max-w-4xl min-w-lg p-8 border border-gray-200 rounded-lg box-shadow-md">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
          </div>

          {/* Artifacts */}
          <div className="hidden lg:block lg:flex-1 lg:min-w-xl">
            <div className="p-8 border border-gray-200 rounded-lg box-shadow-md bg-white">
              <h3>Generated code goes here!</h3>
              <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
            </div>
          </div>
        </div>

        <footer className="w-full text-gray-500 text-center p-10">
          <p className="font-semibold mb-2">Made with ❤️ by <a href="https://gruntwork.io">Gruntwork</a></p>
          <p>Copyright 2025 Gruntwork Inc. All rights reserved.</p>
        </footer>
      </div>
    </>
  )
}

export default App