import { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Copy, Check } from "lucide-react"
import { copyTextToClipboard } from "@/lib/utils"

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
      const ok = await copyTextToClipboard(code)
      if (!ok) {
        console.error('Failed to copy text')
        return
      }
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // Handle copy path with checkmark feedback
  const handleCopyPath = async () => {
    const ok = await copyTextToClipboard(filePath)
    if (!ok) {
      console.error('Failed to copy text')
      return
    }
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  return (
    <div className={`text-xs text-muted-foreground border border-border px-2 -mb-2 font-sans h-8 bg-muted flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2">
        <div>{filePath}</div>
        {showCopyPathButton && (
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyPath}
                className="h-5 w-5 text-muted-foreground hover:cursor-pointer shadow-none"
              >
                {copiedPath ? <Check className="h-2 w-2 text-muted-foreground" /> : <Copy className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedPath ? "Copied!" : "Copy local path"}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      

      <div className="flex gap-2">
        {showCopyCodeButton && (
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopyCode}
                className="h-5 w-5 text-muted-foreground hover:cursor-pointer"
              >
                {copiedCode ? <Check className="h-2 w-2 text-muted-foreground" /> : <Copy className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{copiedCode ? "Copied!" : "Copy raw file"}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
};
