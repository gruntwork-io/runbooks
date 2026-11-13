import { FoldHorizontal, UnfoldHorizontal, type LucideProps } from "lucide-react"
import type { ComponentType } from "react"
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu"
import { useRunbookLayout } from "@/contexts/useRunbookLayout"
import {
  RUNBOOK_LAYOUT_LABELS,
  RUNBOOK_LAYOUT_NAME,
  type RunbookLayout,
} from "@/contexts/RunbookLayoutContext.types"

const OPTIONS: { value: RunbookLayout; icon: ComponentType<LucideProps> }[] = [
  { value: "fixed", icon: FoldHorizontal },
  { value: "fill", icon: UnfoldHorizontal },
]

/**
 * Runbook width picker for the Header's Menu dropdown. Mirrors ThemeToggle: a
 * labeled radio group of Fixed / Fill window; must be placed inside a
 * <DropdownMenuContent>.
 */
export function RunbookLayoutToggle() {
  const { layout, setLayout } = useRunbookLayout()

  return (
    <>
      <DropdownMenuLabel>{RUNBOOK_LAYOUT_NAME}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={layout}
        onValueChange={(value) => setLayout(value as RunbookLayout)}
      >
        {OPTIONS.map(({ value, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon className="size-4" />
            {RUNBOOK_LAYOUT_LABELS[value]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
