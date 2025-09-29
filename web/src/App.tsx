import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState } from 'react'
import { BookOpen, Code, AlertTriangle } from "lucide-react"
import { Header } from './components/Header'
import { MDXContainer } from './components/MDXContainer'
import { ArtifactsContainer } from './components/ArtifactsContainer'
import { ViewContainerToggle } from './components/ViewContainerToggle'
import { getDirectoryPath } from './lib/utils'
import { useGetRunbook } from './hooks/useApiGetRunbook'


function App() {
  const [activeMobileSection, setActiveMobileSection] = useState<'markdown' | 'tabs'>('markdown')
  
  // Use the useApi hook to fetch runbook data
  const { data, isLoading, error } = useGetRunbook()
  
  // Extract commonly used values
  const pathName = data?.path || ''
  const content = data?.content || ''
  const runbookPath = getDirectoryPath(pathName)

  // Check if there is an error
  function hasError() {
    return Boolean(error?.message || error?.details);
  }

  return (
    <>
      <div className="flex flex-col">
        <Header pathName={pathName} />
        
        {/* Loading and Error States */}
        {isLoading ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading runbook...</p>
            </div>
          </div>
        ) : hasError() ? (
          <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
            <div className="text-center max-w-md mx-auto p-6">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <h3 className="text-lg font-medium text-red-800 mb-2">Failed to Load Runbook</h3>
                <p className="text-red-700 mb-2">{error?.message}</p>
                <p className="text-sm text-red-600 mb-4">
                  {error?.details}
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
                    content={content}
                    className="flex-1 max-w-3xl min-w-xl p-8"
                    runbookPath={runbookPath}
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
                    content={content}
                    className="p-6 w-full max-h-[calc(100vh-9.5rem)]"
                    runbookPath={runbookPath}
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