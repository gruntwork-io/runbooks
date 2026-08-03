import { useState, useEffect, useRef } from "react"
import { Check, ChevronsUpDown, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { GCP_REGIONS } from "../constants"

interface RegionPickerProps {
  selectedRegion: string
  setSelectedRegion: (region: string) => void
  disabled?: boolean
}

/**
 * Compute region picker — the DefaultRegionPicker analogue. A GCP region is
 * SECONDARY (the project is the primary selection), so unlike AWS this field is
 * genuinely optional and offers an explicit "no default region" row.
 */
export function RegionPicker({ selectedRegion, setSelectedRegion, disabled }: RegionPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll to top whenever search changes or popover opens
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTo({ top: 0 })
    }
  }, [open, search])

  return (
    <div>
      <label className="text-sm font-medium text-foreground mb-1 flex items-center gap-1.5">
        Default Region <span className="font-normal text-muted-foreground">(optional)</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground cursor-help">
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            The Google Cloud region used by commands that don't specify one. This sets the <code>CLOUDSDK_COMPUTE_REGION</code> and <code>GOOGLE_CLOUD_REGION</code> environment variables.
          </TooltipContent>
        </Tooltip>
      </label>
      <Popover open={open} onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) setSearch("") // Reset search when closing
      }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
            disabled={disabled}
          >
            {selectedRegion ? (
              <span className="flex items-center gap-2 truncate">
                <span className="font-mono text-xs text-muted-foreground">{selectedRegion}</span>
                <span className="text-foreground">
                  {GCP_REGIONS.find((r) => r.code === selectedRegion)?.name}
                </span>
              </span>
            ) : (
              "Select region..."
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start" side="bottom" avoidCollisions={false}>
          <Command>
            <CommandInput
              placeholder="Search regions..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList ref={listRef} className="max-h-[300px]">
              <CommandEmpty>No region found.</CommandEmpty>
              <CommandGroup>
                {selectedRegion && (
                  <CommandItem
                    key="__none__"
                    value="none no default region clear"
                    onSelect={() => {
                      setSelectedRegion('')
                      setOpen(false)
                    }}
                    className="flex items-center gap-2"
                  >
                    <Check className="h-4 w-4 shrink-0 opacity-0" />
                    <span className="text-muted-foreground">No default region</span>
                  </CommandItem>
                )}
                {GCP_REGIONS.map((region) => (
                  <CommandItem
                    key={region.code}
                    value={`${region.code} ${region.name} ${region.geography}`}
                    onSelect={() => {
                      setSelectedRegion(region.code)
                      setOpen(false)
                    }}
                    className="flex items-center gap-2"
                  >
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        selectedRegion === region.code ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="font-mono text-xs text-muted-foreground w-[120px] shrink-0">
                      {region.code}
                    </span>
                    <span className="text-foreground truncate">
                      {region.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
