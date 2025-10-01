import { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Copy, FolderOpen, Check } from "lucide-react"

// Copy function
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

export interface CodeFileHeaderProps {
  filePath: string;
  code?: string; // Code content for copy functionality
  showCopyCodeButton?: boolean;
  showCopyPathButton?: boolean;
  className?: string;
}

export const CodeFileHeader = ({ 
  filePath, 
  code,
  showCopyCodeButton = true,
  showCopyPathButton = true,
  className = ""
}: CodeFileHeaderProps) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  // Handle copy code with checkmark feedback
  const handleCopyCode = async () => {
    if (code) {
      await copyToClipboard(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // Handle copy path with checkmark feedback
  const handleCopyPath = async () => {
    await copyToClipboard(filePath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  return (
    <div className={`text-xs text-gray-600 border border-gray-300 px-2 -mb-2 font-sans h-8 bg-gray-100 flex items-center justify-between ${className}`}>
      <div>{filePath}</div>
      <div className="flex gap-2">
        {showCopyCodeButton && (
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyCode}
                className="h-5 w-5 text-gray-400 hover:cursor-pointer"
              >
                {copiedCode ? <Check className="h-3 w-3 text-gray-400" /> : <Copy className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedCode ? "Copied!" : "Copy code"}</p>
            </TooltipContent>
          </Tooltip>
        )}
        
        {showCopyPathButton && (
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyPath}
                className="h-5 w-5 text-gray-400 hover:cursor-pointer box-shadow-none"
              >
                {copiedPath ? <Check className="h-3 w-3 text-gray-400" /> : <FolderOpen className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedPath ? "Copied!" : "Copy local path"}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
