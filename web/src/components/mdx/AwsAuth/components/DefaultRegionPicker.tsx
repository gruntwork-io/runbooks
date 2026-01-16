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
import { AWS_REGIONS } from "../constants"

interface DefaultRegionPickerProps {
  selectedRegion: string
  setSelectedRegion: (region: string) => void
  disabled?: boolean
}

export function DefaultRegionPicker({ selectedRegion, setSelectedRegion, disabled }: DefaultRegionPickerProps) {
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
      <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
        Default Region
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-gray-400 hover:text-gray-600 cursor-help">
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            This is the AWS region used by CLI commands that don't explicitly specify a region. This sets the <code>AWS_REGION</code> environment variable.
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
            className="w-full justify-between font-normal bg-white border-gray-300 hover:bg-gray-50"
            disabled={disabled}
          >
            {selectedRegion ? (
              <span className="flex items-center gap-2 truncate">
                <span className="font-mono text-xs text-gray-500">{selectedRegion}</span>
                <span className="text-gray-700">
                  {AWS_REGIONS.find((r) => r.code === selectedRegion)?.name}
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
                {AWS_REGIONS.map((region) => (
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
                    <span className="font-mono text-xs text-gray-500 w-[120px] shrink-0">
                      {region.code}
                    </span>
                    <span className="text-gray-700 truncate">
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
