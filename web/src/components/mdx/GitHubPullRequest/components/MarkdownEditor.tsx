import { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
}

export function MarkdownEditor({ value, onChange, disabled = false, placeholder }: MarkdownEditorProps) {
  const [activeTab, setActiveTab] = useState<'write' | 'preview'>('write')

  return (
    <div className="border border-gray-300 rounded-md overflow-hidden bg-white">
      {/* Tab header */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        <button
          type="button"
          onClick={() => setActiveTab('write')}
          className={`px-3 py-1.5 text-xs font-medium cursor-pointer ${
            activeTab === 'write'
              ? 'text-gray-900 border-b-2 border-blue-500 bg-white'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('preview')}
          className={`px-3 py-1.5 text-xs font-medium cursor-pointer ${
            activeTab === 'preview'
              ? 'text-gray-900 border-b-2 border-blue-500 bg-white'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Preview
        </button>
      </div>

      {/* Content */}
      {activeTab === 'write' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          rows={6}
          className="w-full px-3 py-2 text-sm font-mono border-none focus:outline-none resize-y disabled:bg-gray-100 disabled:text-gray-500 placeholder:text-gray-400"
        />
      ) : (
        <div className="px-3 py-2 min-h-[120px] text-sm">
          {value ? (
            <div className="markdown-body markdown-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {value}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-gray-400 italic text-sm">Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  )
}
