import { useMemo } from 'react'

interface DiffViewerProps {
  diff: string
  fileName?: string
  className?: string
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLineNum?: number
  newLineNum?: number
}

function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n')
  const result: DiffLine[] = []
  let oldLineNum = 0
  let newLineNum = 0

  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -start,count +start,count @@
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
      if (match) {
        oldLineNum = parseInt(match[1], 10)
        newLineNum = parseInt(match[2], 10)
      }
      result.push({ type: 'hunk', content: line })
    } else if (line.startsWith('+')) {
      result.push({
        type: 'add',
        content: line.substring(1),
        newLineNum: newLineNum++,
      })
    } else if (line.startsWith('-')) {
      result.push({
        type: 'remove',
        content: line.substring(1),
        oldLineNum: oldLineNum++,
      })
    } else if (line.startsWith(' ') || line === '') {
      result.push({
        type: 'context',
        content: line.substring(1) || '',
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      })
    }
  }

  return result
}

function getLineClasses(type: DiffLine['type']): string {
  switch (type) {
    case 'add':
      return 'bg-green-50 border-l-4 border-green-400'
    case 'remove':
      return 'bg-red-50 border-l-4 border-red-400'
    case 'header':
      return 'bg-gray-100 text-gray-600 font-medium'
    case 'hunk':
      return 'bg-blue-50 text-blue-700'
    default:
      return ''
  }
}

function getContentClasses(type: DiffLine['type']): string {
  switch (type) {
    case 'add':
      return 'text-green-800'
    case 'remove':
      return 'text-red-800'
    default:
      return 'text-gray-700'
  }
}

export function DiffViewer({ diff, fileName, className = '' }: DiffViewerProps) {
  const parsedLines = useMemo(() => parseDiff(diff), [diff])

  if (!diff || !diff.trim()) {
    return (
      <div className={`p-4 text-center text-gray-500 ${className}`}>
        No changes to display
      </div>
    )
  }

  return (
    <div className={`font-mono text-sm ${className}`}>
      {fileName && (
        <div className="px-4 py-2 bg-gray-100 border-b border-gray-200 font-medium text-gray-700">
          {fileName}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {parsedLines.map((line, index) => (
              <tr key={index} className={getLineClasses(line.type)}>
                {/* Line numbers */}
                <td className="w-12 px-2 py-0.5 text-right text-gray-400 select-none border-r border-gray-200 text-xs">
                  {line.type === 'add' || line.type === 'context' ? line.newLineNum : ''}
                </td>
                <td className="w-12 px-2 py-0.5 text-right text-gray-400 select-none border-r border-gray-200 text-xs">
                  {line.type === 'remove' || line.type === 'context' ? line.oldLineNum : ''}
                </td>
                {/* Prefix */}
                <td className="w-6 px-1 py-0.5 text-center select-none">
                  {line.type === 'add' && <span className="text-green-600">+</span>}
                  {line.type === 'remove' && <span className="text-red-600">-</span>}
                </td>
                {/* Content */}
                <td className={`px-2 py-0.5 whitespace-pre ${getContentClasses(line.type)}`}>
                  {line.content || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
