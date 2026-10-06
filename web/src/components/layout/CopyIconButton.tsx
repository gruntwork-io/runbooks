import { useState, type ComponentType } from "react"
import { Check, type LucideProps } from "lucide-react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip"

interface CopyIconButtonProps {
  /** What a click copies */
  value: string
  icon: ComponentType<LucideProps>
  /** Names the button, and is what its tooltip says, e.g. "Copy session name" */
  label: string
  /** What the button says once it has copied, e.g. "Session name copied" */
  copiedLabel: string
}

/**
 * An icon button in the title bar that copies `value`. Hovering it says what
 * it copies. A click copies it and says so in a tooltip for a moment, whether
 * or not the pointer is still on the button.
 */
export function CopyIconButton({ value, icon: Icon, label, copiedLabel }: CopyIconButtonProps) {
  const { didCopy, copy } = useCopyToClipboard()
  const [isHovered, setIsHovered] = useState(false)
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip open={didCopy || isHovered} onOpenChange={setIsHovered}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            // The header is the window's drag region; anything clickable in it opts out.
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onClick={() => void copy(value)}
          >
            {didCopy ? (
              <Check aria-hidden className="size-3.5 text-success" />
            ) : (
              <Icon aria-hidden className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{didCopy ? copiedLabel : label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
