import type { ComponentPropsWithRef, ComponentType } from "react"
import { Check, Copy, FolderOpen, type LucideProps } from "lucide-react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip"

function CopyButton({
  didCopy,
  icon: Icon,
  size,
  className,
  ref,
  ...props
}: {
  didCopy: boolean
  icon: ComponentType<LucideProps>
  size: string
} & ComponentPropsWithRef<"button">) {
  return (
    <button
      type="button"
      className={`flex-shrink-0 rounded transition-colors cursor-pointer ${className ?? ""}`}
      // The header is the window's drag region; anything clickable in it opts out.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      aria-label="Copy session directory"
      {...props}
      ref={ref}
    >
      {didCopy ? (
        <Check className={`${size} text-success`} />
      ) : (
        <Icon className={`${size} text-muted-foreground`} />
      )}
    </button>
  )
}

interface SessionDirButtonProps {
  /** The absolute path of the session's own directory */
  dir: string
}

/**
 * The folder button next to the session's name in the title bar. Clicking it
 * copies the path of the session's directory, where its scripts start and its
 * clones and generated files are. Hovering shows the path.
 */
export function SessionDirButton({ dir }: SessionDirButtonProps) {
  const { didCopy, copy } = useCopyToClipboard()
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CopyButton
            onClick={() => void copy(dir)}
            didCopy={didCopy}
            icon={FolderOpen}
            size="size-3.5"
            className="p-1 hover:bg-accent"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm">
          <p className="text-xs font-medium mb-1">Session directory:</p>
          <div className="flex items-start gap-1.5">
            <p className="text-xs text-muted-foreground font-mono break-all">{dir}</p>
            <CopyButton
              onClick={() => void copy(dir)}
              didCopy={didCopy}
              icon={Copy}
              size="size-3"
              className="p-0.5 hover:bg-white/10"
            />
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
