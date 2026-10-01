import { useState, useMemo } from 'react'
import { UnfoldVertical, ArrowUpToLine, ArrowDownToLine } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildDiffSections, getExpandedLines, type DiffLine } from '@/lib/unifiedDiff'

interface DiffTableProps {
  diffLines: DiffLine[];
}

/**
 * A unified diff: each change with a few lines of context, and the unchanged
 * runs between them collapsed behind an expand bar.
 *
 * Inside a runbook block, github-markdown.css restyles every table, row, cell
 * and code element. The display, border, background and padding utilities
 * below override those rules, so they are needed even where they look redundant.
 */
export const DiffTable = ({ diffLines }: DiffTableProps) => {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

  // Create sections with collapsed context
  const sections = useMemo(() => buildDiffSections(diffLines), [diffLines])

  const toggleSection = (index: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  return (
    <div className="font-mono text-xs">
      <table className="table w-full border-collapse">
        <tbody>
          {sections.map((section, sectionIndex) => {
            if (section.type === 'collapsed') {
              const isExpanded = expandedSections.has(sectionIndex)

              if (isExpanded) {
                // Show the expanded lines
                const expandedLines = getExpandedLines(diffLines, sections, sectionIndex)
                return expandedLines.map((line, lineIndex) => (
                  <DiffLineRow key={`${sectionIndex}-exp-${lineIndex}`} line={line} />
                ))
              }

              // Show the expand bar with position-aware icons
              const position = section.position || 'middle'
              const ExpandIcon = position === 'top'
                ? ArrowUpToLine
                : position === 'bottom'
                ? ArrowDownToLine
                : UnfoldVertical

              return (
                <tr key={`collapsed-${sectionIndex}`} className="border-0 bg-info-muted">
                  <td colSpan={4} className="border-0 py-0 px-0">
                    <button
                      onClick={() => toggleSection(sectionIndex)}
                      className="w-full flex items-center gap-2 py-1.5 px-3 text-muted-foreground hover:text-foreground hover:bg-info-muted cursor-pointer transition-colors"
                    >
                      <ExpandIcon className="w-4 h-4" />
                      <span className="text-xs font-medium">
                        Expand {section.collapsedCount} hidden lines
                      </span>
                    </button>
                  </td>
                </tr>
              )
            }

            // Regular lines section
            return section.lines?.map((line, lineIndex) => (
              <DiffLineRow key={`${sectionIndex}-${lineIndex}`} line={line} />
            ))
          })}
        </tbody>
      </table>
    </div>
  )
}

interface DiffLineRowProps {
  line: DiffLine;
}

const diffLineStyles: Record<string, { bg: string; prefix: string; prefixColor: string; lineNumBg: string }> = {
  addition: { bg: 'bg-success-muted', prefix: '+', prefixColor: 'text-success', lineNumBg: 'bg-success-muted' },
  deletion: { bg: 'bg-destructive-muted', prefix: '-', prefixColor: 'text-destructive', lineNumBg: 'bg-destructive-muted' },
  context:  { bg: 'bg-transparent', prefix: ' ', prefixColor: 'text-muted-foreground', lineNumBg: 'bg-muted' },
}

const DiffLineRow = ({ line }: DiffLineRowProps) => {
  const { bg: bgColor, prefix, prefixColor, lineNumBg } = diffLineStyles[line.type] ?? diffLineStyles.context

  return (
    <tr className={cn("border-0", bgColor)}>
      {/* Old line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-muted-foreground select-none border-0 border-r border-border",
        lineNumBg
      )}>
        {line.type !== 'addition' ? line.oldLineNum : ''}
      </td>
      {/* New line number */}
      <td className={cn(
        "w-12 px-2 py-0 text-right text-muted-foreground select-none border-0 border-r border-border",
        lineNumBg
      )}>
        {line.type !== 'deletion' ? line.newLineNum : ''}
      </td>
      {/* Prefix (+/-/space) */}
      <td className={cn("w-6 border-0 px-1 py-0 text-center select-none font-bold", prefixColor)}>
        {prefix}
      </td>
      {/* Content */}
      <td className="border-0 px-2 py-0 whitespace-pre">
        <code className={cn(
          "rounded-none bg-transparent p-0 text-xs whitespace-pre",
          line.type === 'addition' && 'text-success',
          line.type === 'deletion' && 'text-destructive'
        )}>
          {line.content}
        </code>
      </td>
    </tr>
  )
}
