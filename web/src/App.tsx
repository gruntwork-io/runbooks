import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import ReactMarkdown from 'react-markdown'
import { useState, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code, CheckCircle, FileText, BookOpen } from "lucide-react"
import { useTree } from '@headless-tree/react'
import { syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature } from '@headless-tree/core'
import { cn } from './lib/utils'

import './css/headless-tree.css'

// Shared tab content components
const CodeTabContent = () => {

  const tree = useTree<string>({
    initialState: { expandedItems: ["folder-1"] },
    rootItemId: "folder",
    getItemName: (item) => item.getItemData(),
    isItemFolder: (item) => !item.getItemData().endsWith("item"),
    dataLoader: {
      getItem: (itemId) => itemId,
      getChildren: (itemId) => [
        `${itemId}-1`,
        `${itemId}-2`,
        `${itemId}-3`,
        `${itemId}-1item`,
        `${itemId}-2item`,
      ],
    },
    indent: 20,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  return (
    <div className="p-1 w-full min-h-[200px]">

      <div {...tree.getContainerProps()} className="tree">
        {tree.getItems().map((item) => (
          <button
            {...item.getProps()}
            key={item.getId()}
            style={{ paddingLeft: `${item.getItemMeta().level * 20}px` }}
          >
            <div
              className={cn("treeitem", {
                focused: item.isFocused(),
                expanded: item.isExpanded(),
                selected: item.isSelected(),
                folder: item.isFolder(),
              })}
            >
              {item.getItemName()}
            </div>
          </button>
        ))}
      </div>

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
  )
}

const ChecksTabContent = () => (
  <div className="p-4 w-full min-h-[200px]">
    <div className="text-sm text-gray-600 mb-3">
      Validation checks and compliance rules
    </div>
    <div className="bg-gray-50 rounded-md p-3 text-sm text-gray-700 space-y-2">
      <div>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</div>
    </div>
  </div>
)

const LogsTabContent = () => (
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
)

// Shared tabs component
const ArtifactsTabs = ({ className = "" }: { className?: string }) => (
  <Tabs defaultValue="code" className={className}>
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
    <TabsContent value="code" className="mt-0 w-full">
      <CodeTabContent />
    </TabsContent>
    <TabsContent value="checks" className="mt-0 w-full">
      <ChecksTabContent />
    </TabsContent>
    <TabsContent value="logs" className="mt-0 w-full">
      <LogsTabContent />
    </TabsContent>
  </Tabs>
)

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
      <div className="flex flex-col items-center justify-center">
        <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold flex">
          <div className="hidden md:block">Gruntwork Runbooks</div>
          <div className="flex-1 flex items-center gap-2 justify-center">
            <div className="text-sm text-gray-500 font-mono font-normal">
              {pathName}
            </div>
          </div>
        </header>
        
        <div className="text-center text-gray-500">
        {loading ? (
          <p>Loading runbook...</p>
        ) : error ? (
          <p className="text-red-600">Error: {error}</p>
        ) : null}
        </div>

        {/* Desktop Layout - Side by side */}
        <div className="hidden lg:block lg:m-8">
          <div className="flex gap-8 min-h-screen">
            {/* Markdown content */}
            <div className="markdown-body flex-1 max-w-3xl min-w-xl p-8 border border-gray-200 rounded-lg shadow-md">
              <ReactMarkdown>{markdownContent}</ReactMarkdown>
            </div>

            {/* Artifacts */}
            <div className="flex-2 sticky top-4 w-2xl self-start">
              <ArtifactsTabs />
            </div>
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
                <ArtifactsTabs className="w-full" />
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