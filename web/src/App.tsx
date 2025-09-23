import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import ReactMarkdown from 'react-markdown'
import { useState, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, FileText, BookOpen } from "lucide-react"

function App() {
  const [markdownContent, setMarkdownContent] = useState('')
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
      <div className="flex flex-col items-center justify-center">
        
        <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold">
          Gruntwork Runbooks
        </header>
        
        <div className="text-center text-gray-500">
        {loading ? (
          <p>Loading runbook...</p>
        ) : error ? (
          <p className="text-red-600">Error: {error}</p>
        ) : null}
        </div>

        {/* Desktop Layout - Side by side */}
        <div className="hidden lg:flex lg:gap-8 lg:w-full m-8">
          {/* Markdown content */}
          <div className="markdown-body lg:flex-1 max-w-3xl min-w-xl p-8 border border-gray-200 rounded-lg shadow-md">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
          </div>

          {/* Artifacts */}
          <div className="lg:flex-2 lg:sticky lg:top-4 lg:w-2xl">
            <Tabs defaultValue="code">
              <TabsList className="w-full justify-start">
                <TabsTrigger value="code" className="flex items-center gap-2">
                  <Code className="size-4" />
                  Code
                </TabsTrigger>
                <TabsTrigger value="checks" className="flex items-center gap-2">
                  <CheckCircle className="size-4" />
                  Checks
                </TabsTrigger>
                <TabsTrigger value="logs" className="flex items-center gap-2">
                  <FileText className="size-4" />
                  Logs
                </TabsTrigger>
              </TabsList>
              <TabsContent value="code" className="mt-0">
                <div>
                  <div className="text-sm text-gray-600 mb-3 w-full">
                    {/* Code content will go here */}
                  </div>
                </div>  
              </TabsContent>
              <TabsContent value="checks" className="mt-0">
                <div className="p-4">
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
                </div>
              </TabsContent>
              <TabsContent value="logs" className="mt-0">
                <div className="p-4">
                  <div className="text-sm text-gray-600 mb-3">
                    Execution logs and deployment history
                  </div>
                  <div className="bg-gray-50 rounded-md p-3 font-mono text-xs text-gray-700 space-y-1">
                    <div>[2025-01-27 10:30:15] Starting deployment...</div>
                    <div>[2025-01-27 10:30:16] Validating configuration...</div>
                    <div>[2025-01-27 10:30:17] Creating security group...</div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* Mobile Layout - Tabbed interface */}
        <div className="lg:hidden w-full">
          {/* Mobile Navigation */}
          <div className="flex items-center justify-center mb-6 mt-8">
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
          <div className="relative w-full px-4">
            {/* Markdown Section */}
            <div className={`transition-all duration-300 ease-in-out ${
              activeMobileSection === 'markdown' 
                ? 'opacity-100 translate-x-0' 
                : 'opacity-0 translate-x-full absolute inset-0 pointer-events-none'
            }`}>
              <div className="markdown-body p-6 border border-gray-200 rounded-lg shadow-md w-full">
                <ReactMarkdown>{markdownContent}</ReactMarkdown>
              </div>
            </div>

            {/* Tabs Section */}
            <div className={`transition-all duration-300 ease-in-out ${
              activeMobileSection === 'tabs' 
                ? 'opacity-100 translate-x-0' 
                : 'opacity-0 -translate-x-full absolute inset-0 pointer-events-none'
            }`}>
              <div className="w-full border border-gray-200 rounded-lg shadow-md">
                <Tabs defaultValue="code" className="w-full">
                  <TabsList className="w-full justify-start rounded-t-lg rounded-b-none">
                    <TabsTrigger value="code" className="flex items-center gap-2">
                      <Code className="size-4" />
                      Code
                    </TabsTrigger>
                    <TabsTrigger value="checks" className="flex items-center gap-2">
                      <CheckCircle className="size-4" />
                      Checks
                    </TabsTrigger>
                    <TabsTrigger value="logs" className="flex items-center gap-2">
                      <FileText className="size-4" />
                      Logs
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="code" className="mt-0 w-full">
                    <div className="p-4 w-full min-h-[200px]">
                      <div className="text-sm text-gray-600 mb-3">
                        Infrastructure code and configuration files
                      </div>
                      <div className="bg-gray-50 rounded-md p-3 font-mono text-xs text-gray-700 space-y-1">
                        <div># Example Infrastructure Code</div>
                        <div># Security group for web server</div>
                        <div>resource "aws_security_group" "web_sg" {`{`}</div>
                        <div>  name_prefix = "web-sg-"</div>
                        <div>  ingress {`{`}</div>
                        <div>    from_port   = 80</div>
                        <div>    to_port     = 80</div>
                        <div>    protocol    = "tcp"</div>
                        <div>    cidr_blocks = ["0.0.0.0/0"]</div>
                        <div>  {`}`}</div>
                        <div>{`}`}</div>
                      </div>
                    </div>  
                  </TabsContent>
                  <TabsContent value="checks" className="mt-0 w-full">
                    <div className="p-4 w-full min-h-[200px]">
                      <div className="text-sm text-gray-600 mb-3">
                        Validation checks and compliance rules
                      </div>
                      <div className="bg-gray-50 rounded-md p-3 text-sm text-gray-700 space-y-2">
                        <div>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</div>
                      </div>
                    </div>
                  </TabsContent>
                  <TabsContent value="logs" className="mt-0 w-full">
                    <div className="p-4 w-full min-h-[200px]">
                      <div className="text-sm text-gray-600 mb-3">
                        Execution logs and deployment history
                      </div>
                      <div className="bg-gray-50 rounded-md p-3 font-mono text-xs text-gray-700 space-y-1">
                        <div>[2025-01-27 10:30:15] Starting deployment...</div>
                        <div>[2025-01-27 10:30:16] Validating configuration...</div>
                        <div>[2025-01-27 10:30:17] Creating security group...</div>
                        <div>[2025-01-27 10:30:18] Security group created successfully</div>
                        <div>[2025-01-27 10:30:19] Applying tags...</div>
                        <div>[2025-01-27 10:30:20] Deployment completed successfully</div>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
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