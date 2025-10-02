import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { useState } from "react"
import { CodeFile } from "@/components/artifacts/code/CodeFile"

interface ViewSourceCodeProps {
  sourceCode: string
  path?: string
  fileName?: string
}

export function ViewSourceCode({ 
  sourceCode, 
  path, 
  fileName = "Check Script" 
}: ViewSourceCodeProps) {
  const [showSourceCode, setShowSourceCode] = useState(false)

  return (
    <div className="border border-gray-200 rounded-sm">
      <button
        onClick={() => setShowSourceCode(!showSourceCode)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
      >
        {showSourceCode ? (
          <ChevronDown className="size-4 text-gray-500" />
        ) : (
          <ChevronRight className="size-4 text-gray-500" />
        )}
        <FileText className="size-4 text-gray-600" />
        <span className="text-sm text-gray-700">View Source Code</span>
      </button>
      {showSourceCode && (
        <div className="border-t border-gray-200 p-3 bg-gray-50">
          <CodeFile
            fileName={fileName}
            filePath={path}
            code={sourceCode}
          />
        </div>
      )}
    </div>
  )
}
