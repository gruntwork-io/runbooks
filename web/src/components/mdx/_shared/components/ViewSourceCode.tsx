import { ChevronDown, ChevronRight, FileText } from "lucide-react"
import { useState } from "react"
import { CodeFile } from "@/components/artifacts/code/CodeFile"

interface ViewSourceCodeProps {
  sourceCode: string
  path?: string
  fileName?: string
  language?: string
  isOpen?: boolean
  onToggle?: (open: boolean) => void
}

export function ViewSourceCode({ 
  sourceCode, 
  path, 
  fileName = "Script",
  language,
  isOpen: externalIsOpen,
  onToggle
}: ViewSourceCodeProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(false)
  
  // Use external state if provided, otherwise use internal state
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen
  
  const handleToggle = () => {
    const newValue = !isOpen
    if (onToggle) {
      onToggle(newValue)
    } else {
      setInternalIsOpen(newValue)
    }
  }

  return (
    <div className="border border-gray-200 rounded-sm">
      <button
        onClick={handleToggle}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
      >
        {isOpen ? (
          <ChevronDown className="size-4 text-gray-500" />
        ) : (
          <ChevronRight className="size-4 text-gray-500" />
        )}
        <FileText className="size-4 text-gray-600" />
        <span className="text-sm text-gray-700">View Source Code</span>
      </button>
      {isOpen && (
        <div className="border-t border-gray-200 p-3 bg-gray-50">
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

