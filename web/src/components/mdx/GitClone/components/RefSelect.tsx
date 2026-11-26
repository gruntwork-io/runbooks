import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, GitBranch, Tag } from "lucide-react"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface RefSelectProps {
  refs: ReadonlyArray<{ name: string; type: "branch" | "tag" }>
  selectedRef: string
  /** The repository's default branch, badged in the list. */
  defaultBranch?: string | undefined
  loading: boolean
  error: string | null
  disabled: boolean
  onSelect: (ref: string) => void
}

/** The branch-or-tag picker shared by the repository browsers. */
export function RefSelect({
  refs,
  selectedRef,
  defaultBranch,
  loading,
  error,
  disabled,
  onSelect,
}: RefSelectProps) {
  const [refOpen, setRefOpen] = useState(false)
  const [refSearch, setRefSearch] = useState("")
  const refListRef = useRef<HTMLDivElement>(null)

  const branchRefs = useMemo(() => refs.filter((r) => r.type === "branch"), [refs])
  const tagRefs = useMemo(() => refs.filter((r) => r.type === "tag"), [refs])
  const selectedRefObj = useMemo(
    () => refs.find((r) => r.name === selectedRef),
    [refs, selectedRef],
  )
  const isDefaultBranch = (ref: RefSelectProps["refs"][number] | undefined) =>
    ref?.type === "branch" && ref.name === defaultBranch

  useEffect(() => {
    if (refOpen && refListRef.current) {
      refListRef.current.scrollTo({ top: 0 })
    }
  }, [refOpen, refSearch])

  const handleSelect = (ref: string) => {
    setRefOpen(false)
    setRefSearch("")
    onSelect(ref)
  }

  return (
    <div>
      <label className="text-sm font-medium text-foreground mb-1 block">Ref</label>
      <Popover
        open={refOpen}
        onOpenChange={(open) => {
          setRefOpen(open)
          if (!open) setRefSearch("")
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={refOpen}
            className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
            disabled={disabled || loading}
          >
            {loading ? (
              <span className="text-muted-foreground">Loading refs...</span>
            ) : selectedRef ? (
              <span className="flex items-center gap-2 truncate">
                {selectedRefObj?.type === "tag" ? (
                  <Tag className="size-3 text-muted-foreground" />
                ) : (
                  <GitBranch className="size-3 text-muted-foreground" />
                )}
                <span className="text-foreground">{selectedRef}</span>
                {isDefaultBranch(selectedRefObj) && (
                  <span className="text-[10px] font-medium bg-info-muted text-info px-1.5 py-0.5 rounded-full leading-none">
                    default
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">Select ref...</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[350px] p-0"
          align="start"
          side="bottom"
          avoidCollisions={false}
        >
          <Command>
            <CommandInput
              placeholder="Search branches and tags..."
              value={refSearch}
              onValueChange={setRefSearch}
            />
            <CommandList ref={refListRef} className="max-h-[300px]">
              <CommandEmpty>No branches or tags found.</CommandEmpty>

              {/* Branches group */}
              {branchRefs.length > 0 && (
                <CommandGroup heading="Branches">
                  {branchRefs.map((ref) => (
                    <CommandItem
                      key={`branch-${ref.name}`}
                      value={ref.name}
                      onSelect={() => handleSelect(ref.name)}
                      className="flex items-center gap-2"
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          selectedRef === ref.name ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <GitBranch className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-foreground truncate">{ref.name}</span>
                      {isDefaultBranch(ref) && (
                        <span className="text-[10px] font-medium bg-info-muted text-info px-1.5 py-0.5 rounded-full leading-none ml-auto shrink-0">
                          default
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {/* Tags group */}
              {tagRefs.length > 0 && (
                <CommandGroup heading="Tags">
                  {tagRefs.map((ref) => (
                    <CommandItem
                      key={`tag-${ref.name}`}
                      value={ref.name}
                      onSelect={() => handleSelect(ref.name)}
                      className="flex items-center gap-2"
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          selectedRef === ref.name ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <Tag className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-foreground truncate">{ref.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
