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
        ) : (
          <p>Runbook loaded successfully</p>
        )}
        </div>

        <div className="mt-8 max-w-4xl">
          <div className="markdown-body p-8 border border-gray-200 rounded-lg box-shadow-md">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
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