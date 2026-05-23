import { ListChecks } from 'lucide-react';
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from '../ui/dropdown-menu';
import { useInstructionMode } from '@/contexts/useInstructionMode';
import { INSTRUCTION_MODE_NAME } from '@/contexts/InstructionModeContext.types';

/**
 * Instruction-mode switch for the Header's Menu dropdown. Mirrors ThemeToggle:
 * a labeled control placed inside a <DropdownMenuContent>. Flips every runbook
 * between the interactive experience and flattened, copy-pasteable instructions.
 */
export function InstructionModeToggle() {
  const { enabled, setEnabled } = useInstructionMode();

  return (
    <>
      <DropdownMenuLabel>Mode</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        checked={enabled}
        onCheckedChange={(checked) => setEnabled(checked === true)}
      >
        <ListChecks className="size-4" />
        {INSTRUCTION_MODE_NAME}
      </DropdownMenuCheckboxItem>
    </>
  );
}
