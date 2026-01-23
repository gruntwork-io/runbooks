import { Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface BlockIdLabelProps {
  id: string
  /** Size variant - 'small' for icon column, 'large' for top-right corner */
  size?: 'small' | 'large'
}

/**
 * A small "ID" label that shows the block ID on hover.
 * Used in MDX blocks to help users identify block IDs.
 */
export function BlockIdLabel({ id, size = 'small' }: BlockIdLabelProps) {
  const sizeClasses = size === 'large' 
    ? 'text-xs px-1.5 py-0.5 bg-gray-200/50 rounded' 
    : 'text-[9px] mt-1'
  
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`text-gray-400 font-mono cursor-help select-none text-center ${sizeClasses}`}>
          ID
        </div>
      </TooltipTrigger>
      <TooltipContent side={size === 'large' ? 'bottom' : 'right'} className="max-w-xs">
        <div className="space-y-2">
          <div className="font-mono text-sm font-medium">{id}</div>
          <div className="flex items-start gap-2 text-xs opacity-80">
            <Info className="size-3 mt-0.5 flex-shrink-0" />
            <span>
              The Block ID is a unique identifier for a block. When one block references another, they do so using the Block ID.
            </span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
