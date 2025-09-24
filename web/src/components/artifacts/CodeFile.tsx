import { useState, useRef } from 'react'
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Copy, FolderOpen, Check } from "lucide-react"
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Copy functions
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

export interface CodeFileProps {
  // File identification
  fileName: string;
  filePath?: string; // Optional path for copy functionality
  
  // Code content
  code: string;
  
  // Syntax highlighting
  language?: string; // Default: 'text'
  style?: any; // SyntaxHighlighter style object, default: coy
  showLineNumbers?: boolean; // Default: true
  
  // Styling
  className?: string;
}

export const CodeFile = ({ 
  fileName, 
  filePath, 
  code, 
  language = 'text',
  style = coy,
  showLineNumbers = true,
  className = ""
}: CodeFileProps) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  // Handle copy code with checkmark feedback
  const handleCopyCode = async () => {
    await copyToClipboard(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Handle copy path with checkmark feedback
  const handleCopyPath = async () => {
    const pathToCopy = filePath || fileName;
    await copyToClipboard(pathToCopy);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  return (
    <div className={className}>
      {/* File Header */}
      <div className="text-xs text-gray-600 border border-gray-300 px-2 -mb-2 font-sans h-8 bg-gray-100 flex items-center justify-between">
        <div>{fileName}</div>
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

      {/* Syntax Highlighter */}
      <SyntaxHighlighter 
        language={language}
        style={style}
        showLineNumbers={showLineNumbers}
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
        {code}
      </SyntaxHighlighter>
    </div>
  );
};
