import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState, useEffect } from 'react'
import { BookOpen, Code, AlertTriangle } from "lucide-react"
import { Header } from './components/Header'
import { MDXContainer } from './components/MDXContainer'
import { ArtifactsContainer } from './components/ArtifactsContainer'
import { ViewContainerToggle } from './components/ViewContainerToggle'


function App() {
  const [markdownContent, setMarkdownContent] = useState('')
  const [pathName, setPathName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState('')
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'tabs'>('markdown')

  useEffect(() => {
    // Get the markdown file content from the API
    const apiUrl = '/api/file'
    fetch(apiUrl)
      .then(response => {
        if (!response.ok) {
          // Try to parse the error response to get detailed error information
          return response.json().then(errorData => {
            const errorMessage = errorData?.error || `HTTP error: ${response.status}`
            const errorDetails = errorData?.details || `Failed to connect to runbook server at ${apiUrl}`
            throw new Error(JSON.stringify({ error: errorMessage, details: errorDetails }))
          })
        } else 
          return response.json()
        }
      )
      .then(data => {
        setMarkdownContent(data.content || '')
        setPathName(data.path || '')
        setLoading(false)
      })
      .catch(err => {
        console.log('Response:', err.message)
        console.error('Error fetching file content:', err)
        
        // Try to parse the error message as JSON to extract error and details
        try {
          const errorData = JSON.parse(err.message)
          setError(errorData.error || 'Unknown error occurred')
          setErrorDetails(errorData.details || 'An unexpected error occurred')
        } catch {
          // If parsing fails, use the original error message
          setError(err.message)
          setErrorDetails(`Failed to connect to runbook server at ${apiUrl}`)
        }
        
        setLoading(false)
      })
  }, []) // Empty dependency array - only run once on mount

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} />
        
        {/* Loading and Error States */}
        {loading ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading runbook...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-md mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2">Failed to Load Runbook</h3>
                <p className="text-red-700 mb-2">{error}</p>
                <p className="text-sm text-red-600 mb-4">
                  {errorDetails}
                </p>
                <button 
                  onClick={() => window.location.reload()} 
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop Layout - Side by side */}
            <div className="hidden lg:block lg:m-6 lg:mt-0 translate translate-y-19 lg:mb-20">
              <div className="flex gap-8 h-[calc(100vh-5rem)] overflow-hidden justify-center">
                {/* Markdown/MDX content */}
                <MDXContainer 
                  content={markdownContent}
                  className="flex-1 max-w-3xl min-w-xl p-8"
                />

                {/* Artifacts */}
                <div className="flex-2 relative max-w-4xl">
                  <ArtifactsContainer className="absolute top-0 left-0 right-0 h-screen" />
                </div>
              </div>
            </div>

            {/* Mobile Layout - Tabbed interface */}
            <div className="lg:hidden w-full pt-20">
              {/* Mobile Navigation */}
              <div className="flex items-center justify-center mb-6 fixed top-18 left-1/2 -translate-x-1/2">
                <div className="bg-gray-100 border border-gray-200 inline-flex h-12 w-fit items-center justify-center rounded-full p-1">
                  <ViewContainerToggle
                    activeView={activeMobileSection}
                    onViewChange={(view) => setActiveMobileSection(view as 'markdown' | 'tabs')}
                    views={[
                      { label: 'Markdown', value: 'markdown', icon: BookOpen },
                      { label: 'Artifacts', value: 'tabs', icon: Code }
                    ]}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Mobile Content */}
              <div className="relative w-full px-4 mt-15">
                {/* Markdown/MDX Section */}
                <div className={`transition-all duration-300 ease-in-out ${
                  activeMobileSection === 'markdown' 
                    ? 'opacity-100 translate-x-0' 
                    : 'opacity-0 translate-x-full absolute inset-0 pointer-events-none'
                }`}>
                  <MDXContainer 
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
          </>
        )}
      </div>
    </>
  )
}

export default App