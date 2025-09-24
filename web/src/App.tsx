import './css/App.css'
import './css/github-markdown.css'
import './css/github-markdown-light.css'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Code, CheckCircle, SquareChevronRight, BookOpen, Copy, FolderOpen, Check } from "lucide-react"
import { useTree } from '@headless-tree/react'
import { syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature } from '@headless-tree/core'
import { cn } from './lib/utils'
import { Header } from './components/Header'
import { MarkdownContainer } from './components/MarkdownContainer'

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism';


import './css/headless-tree.css'

// Simple OpenTofu example
const codeString = `# Simple OpenTofu configuration
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

# Create a VPC
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "main-vpc"
  }
}

# Create a security group
resource "aws_security_group" "web" {
  name_prefix = "web-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}`

// Copy functions
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

// Shared tab content components
const CodeTabContent = () => {
  const [treeWidth, setTreeWidth] = useState(200);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const mainTfRef = useRef<HTMLDivElement>(null);
  const varsTfRef = useRef<HTMLDivElement>(null);

  const tree = useTree<string>({
    // initialState: { expandedItems: ["folder-1"] },
    rootItemId: "folder",
    getItemName: (item) => item.getItemData(),
    isItemFolder: (item) => !item.getItemData().endsWith("item") && !item.getItemData().endsWith(".tf"),
    dataLoader: {
      getItem: (itemId) => itemId,
      getChildren: (itemId) => {
        if (itemId === "folder") {
          return [
            "folder-1",
            "folder-2",
            "folder-3",
            "main.tf",
            "vars.tf",
          ];
        }
        return [
          `${itemId}-1`,
          `${itemId}-2`,
          `${itemId}-3`,
          `${itemId}-1item`,
          `${itemId}-2item`,
        ];
      },
    },
    indent: 20,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // Get tree items
  const treeItems = tree.getItems();

  // Calculate the optimal width based on the longest item name
  const optimalWidth = useMemo(() => {
    if (treeItems.length === 0) return 200;

    // Find the longest item name
    const longestName = treeItems.reduce((longest, item) => {
      const name = item.getItemName();
      return name.length > longest.length ? name : longest;
    }, '');

    // Calculate width based on character count (roughly 8px per character + padding)
    const baseWidth = 40; // Base padding
    const charWidth = 8; // Approximate width per character
    const calculatedWidth = baseWidth + (longestName.length * charWidth);
    
    // Constrain between min and max widths
    const minWidth = 150;
    const maxWidth = 300;
    
    return Math.max(minWidth, Math.min(maxWidth, calculatedWidth));
  }, [treeItems]);

  // Update tree width when optimal width changes
  useEffect(() => {
    setTreeWidth(optimalWidth);
  }, [optimalWidth]);

  // Handle copy code with checkmark feedback
  const handleCopyCode = async () => {
    await copyToClipboard(codeString);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Handle copy path with checkmark feedback
  const handleCopyPath = async () => {
    await copyToClipboard("main.tf");
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  // Handle scrolling to file sections
  const scrollToMainTf = () => {
    if (mainTfRef.current) {
      const elementTop = mainTfRef.current.offsetTop;
      const scrollContainer = mainTfRef.current.closest('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: elementTop - 52, // 52px above the file header to ensure it's visible
          behavior: 'smooth'
        });
      }
    }
  };

  const scrollToVarsTf = () => {
    if (varsTfRef.current) {
      const elementTop = varsTfRef.current.offsetTop;
      const scrollContainer = varsTfRef.current.closest('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: elementTop - 52, // 52px above the file header to ensure it's visible
          behavior: 'smooth'
        });
      }
    }
  };

  return (
    <div className="p-1 w-full min-h-[200px]">

      <div 
        {...tree.getContainerProps()} 
        className="tree absolute"
        style={{ width: `${treeWidth}px` }}
      >
        {tree.getItems().map((item) => {
          const handleClick = (e: React.MouseEvent) => {
            // Let the tree handle its own selection first
            const treeProps = item.getProps();
            if (treeProps.onClick) {
              treeProps.onClick(e);
            }
            
            // Then handle our custom scroll behavior
            const itemName = item.getItemName();
            if (itemName === 'main.tf') {
              scrollToMainTf();
            } else if (itemName === 'vars.tf') {
              scrollToVarsTf();
            }
          };

          return (
            <button
              {...item.getProps()}
              key={item.getId()}
              style={{ paddingLeft: `${item.getItemMeta().level * 20}px` }}
              onClick={handleClick}
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
          );
        })}
      </div>

      {/* <div className="ml-[200px]"> */}
      <div style={{ marginLeft: `${treeWidth}px` }}>
        
        <div ref={mainTfRef} className="text-xs text-gray-600 border border-gray-300 px-2 -mb-2 font-sans h-8 bg-gray-100 flex items-center justify-between">
          <div>main.tf</div>
          <div className="flex gap-2">
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyCode}
                className="h-5 w-5 text-gray-400 hover:cursor-pointer"
              >
                {copiedCode ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedCode ? "Copied!" : "Copy code"}</p>
            </TooltipContent>
          </Tooltip>
          
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyPath}
                className="h-5 w-5 text-gray-400 hover:cursor-pointer"
              >
                {copiedPath ? <Check className="h-3 w-3 text-green-600" /> : <FolderOpen className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedPath ? "Copied!" : "Copy local path"}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        </div>
        <SyntaxHighlighter 
          language="hcl" 
          style={coy}
          showLineNumbers={true}
          customStyle={{
            fontSize: '12px',
            border: '1px solid #ddd',
            borderRadius: '2px',
            padding: '14px 0px'
          }}
          lineNumberStyle={{
            color: '#999',
            fontSize: '11px',
            paddingRight: '12px',
            borderRight: '1px solid #eee',
            marginRight: '8px'
          }}
        >
          {codeString}
        </SyntaxHighlighter>

        <div ref={varsTfRef} className="text-xs text-gray-600 border border-gray-300 p-2 -mb-2 font-sans bg-gray-100">
          vars.tf
        </div>
        <SyntaxHighlighter 
          language="hcl" 
          style={coy}
          showLineNumbers={true}
          customStyle={{
            fontSize: '12px',
            border: '1px solid #ddd',
            borderRadius: '2px',
            padding: '14px 0px'
          }}
          lineNumberStyle={{
            color: '#999',
            fontSize: '11px',
            paddingRight: '12px',
            borderRight: '1px solid #eee',
            marginRight: '8px'
          }}
        >
          {codeString}
        </SyntaxHighlighter>
        
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
    <div className="sticky top-0 z-20 bg-bg-default pt-6 translate -translate-y-6">
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
          <SquareChevronRight className="size-4" />
          Commands
        </TabsTrigger>
      </TabsList>
    </div>
    <div className="overflow-y-auto max-h-[calc(100vh-8rem)] -mt-5">
      <TabsContent value="code" className="mt-0 w-full">
        <CodeTabContent />
      </TabsContent>
      <TabsContent value="checks" className="mt-0 w-full">
        <ChecksTabContent />
      </TabsContent>
      <TabsContent value="logs" className="mt-0 w-full">
        <LogsTabContent />
      </TabsContent>
    </div>
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
            <div className="flex-2 w-2xl self-start relative">
              <ArtifactsTabs className="absolute top-0 left-0 right-0 h-screen" />
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
                <ArtifactsTabs className="w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default App