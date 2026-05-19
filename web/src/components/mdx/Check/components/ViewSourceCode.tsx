import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { useState } from "react"
import { CodeFile } from "@/components/artifacts/code/CodeFile"

interface ViewSourceCodeProps {
  sourceCode: string
  path?: string
  fileName?: string
  language?: string
}

export function ViewSourceCode({ 
  sourceCode, 
  path, 
  fileName = "Check Script",
  language
}: ViewSourceCodeProps) {
  const [showSourceCode, setShowSourceCode] = useState(false)

  return (
    <div className="border border-border rounded-sm">
      <button
        onClick={() => setShowSourceCode(!showSourceCode)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors cursor-pointer"
      >
        {showSourceCode ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        <FileText className="size-4 text-muted-foreground" />
        <span className="text-sm text-foreground">View Source Code</span>
      </button>
      {showSourceCode && (
        <div className="border-t border-border p-3 bg-muted">
          <CodeFile
            fileName={fileName}
            filePath={path}
            code={sourceCode}
            language={language}
          />
        </div>
      )}
    </div>
  )
}
