import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import ReactMarkdown from 'react-markdown'
import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, FileText } from "lucide-react"

function App() {
  const [markdownContent, setMarkdownContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editorHeight, setEditorHeight] = useState(200)
  const [editorContent, setEditorContent] = useState(`# Example Infrastructure Code

# Security group for web server
resource "aws_security_group" "web_sg" {
  name_prefix = "web-sg-"
  
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  tags = {
    Name = "WebServerSecurityGroup"
  }
}`)

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

  // Handle editor mount to enable auto-height
  // This is necessary to set the editor height to automatically match the content height on mount
  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor) => {
    const updateHeight = () => {
      const contentHeight = editor.getContentHeight()
      setEditorHeight(contentHeight)
    }

    // Use requestAnimationFrame to ensure DOM is fully rendered
    // Prior to this, we had a race condition where the editor was
    // not fully initialized when we tried to set the height
    requestAnimationFrame(() => {
      // Add a small delay to ensure the editor is fully initialized
      setTimeout(() => {
        updateHeight()
        
        // Also listen for content changes to update height
        editor.onDidContentSizeChange(() => {
          updateHeight()
        })
      }, 100)
    })
  }

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

        <div className="m-8 flex gap-8">

          {/* Markdown content */}
          <div className="markdown-body lg:flex-1 max-w-3xl min-w-lg p-8 border border-gray-200 rounded-lg box-shadow-md">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
          </div>

          {/* Artifacts */}
          <div className="hidden lg:block lg:flex-2">
            <div className="hidden lg:block lg:sticky top-4">
              <div className="border border-gray-200 rounded-lg box-shadow-md bg-bg-default">
                <div className="bg-white px-4 py-3 border-b border-gray-200">
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
                        <div className="text-sm text-gray-600 mb-3">
                        
                        { /* Code editor */}
                        <div className="border border-gray-200">
                          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                            <h3 className="text-sm font-medium text-gray-700 pt-1">main.tf</h3>
                          </div>
                          <Editor
                            key="monaco-editor"
                            height={`${editorHeight}px`}
                            defaultLanguage="hcl"
                            value={editorContent}
                            onChange={(value) => setEditorContent(value || '')}
                            onMount={handleEditorDidMount}
                            theme="vs"
                            options={{
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              fontSize: 14,
                              lineNumbers: 'on',
                              wordWrap: 'on',
                              automaticLayout: true,
                              padding: { top: 16, bottom: 16 },
                              fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                            }}
                          />
                        </div>
                        { /* End code editor */}

                        </div>
                      </div>  
                    </TabsContent>
                    <TabsContent value="checks" className="mt-0">
                      <div className="p-4">
                        <div className="text-sm text-gray-600 mb-3">
                          Validation checks and compliance rules
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-sm">
                            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                            <span className="text-gray-700">Security group rules validated</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                            <span className="text-gray-700">CIDR blocks properly configured</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
                            <span className="text-gray-700">Tags review recommended</span>
                          </div>
                        </div>
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
                          <div className="text-green-600">[2025-01-27 10:30:18] ✓ Deployment completed successfully</div>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
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