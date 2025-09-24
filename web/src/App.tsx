import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState, useEffect } from 'react'
import { BookOpen, Code } from "lucide-react"
import { Header } from './components/Header'
import { MarkdownContainer } from './components/MarkdownContainer'
import { ArtifactsContainer } from './components/ArtifactsContainer'


function App() {
  const [markdownContent, setMarkdownContent] = useState('')
  const [pathName, setPathName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'tabs'>('markdown')

  useEffect(() => {
    // Get the markdown file content from the API
    fetch('http://localhost:7825/api/file')
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
        return response.json()
      })
      .then(data => {
        setMarkdownContent(data.content || '')
        setPathName(data.path || '')
        setLoading(false)
      })
      .catch(err => {
        console.error('Error fetching file content:', err)
        setError(err.message)
        setLoading(false)
      })
  }, []) // Empty dependency array - only run once on mount

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} />
        
        { /* TODO: Componentize the error and loading messages and show in a better way */}
        <div className="text-center text-gray-500">
        {loading ? (
          <p>Loading runbook...</p>
        ) : error ? (
          <p className="text-red-600">Error: {error}</p>
        ) : null}
        </div>

        {/* Desktop Layout - Side by side */}
        <div className="hidden lg:block lg:m-6 lg:mt-0 translate translate-y-19 lg:mb-20">
          <div className="flex gap-8 h-[calc(100vh-5rem)] overflow-hidden">
            {/* Markdown content */}
            <MarkdownContainer 
              content={markdownContent}
              className="flex-1 max-w-3xl min-w-xl p-8"
            />

            {/* Artifacts */}
            <div className="flex-2 relative">
              <ArtifactsContainer className="absolute top-0 left-0 right-0 h-screen" />
            </div>
          </div>
        </div>

        {/* Mobile Layout - Tabbed interface */}
        <div className="lg:hidden w-full pt-20">
          {/* Mobile Navigation */}
          <div className="flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2">
            <div className="bg-gray-100 border border-gray-200 inline-flex h-12 w-fit items-center justify-center rounded-full p-1">
              <button
                onClick={() => setActiveMobileSection('markdown')}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                  activeMobileSection === 'markdown'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <BookOpen className="size-4" />
                Markdown
              </button>
              <button
                onClick={() => setActiveMobileSection('tabs')}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                  activeMobileSection === 'tabs'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Code className="size-4" />
                Artifacts
              </button>
            </div>
          </div>

          {/* Mobile Content */}
          <div className="relative w-full px-4 mt-15">
            {/* Markdown Section */}
            <div className={`transition-all duration-300 ease-in-out ${
              activeMobileSection === 'markdown' 
                ? 'opacity-100 translate-x-0' 
                : 'opacity-0 translate-x-full absolute inset-0 pointer-events-none'
            }`}>
              <MarkdownContainer 
                content={markdownContent}
                className="p-6 w-full max-h-[calc(100vh-9.5rem)]"
              />
            </div>

            {/* Tabs Section */}
            <div className={`transition-all duration-300 ease-in-out ${
              activeMobileSection === 'tabs' 
                ? 'opacity-100 translate-x-0' 
                : 'opacity-0 -translate-x-full absolute inset-0 pointer-events-none'
            }`}>
              <div className="w-full max-h-[calc(100vh-12rem)] overflow-y-auto">
                <ArtifactsContainer className="w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default App