import { useMemo } from "react"
import { KeyRound } from "lucide-react"
import { Instruction } from "@/components/mdx/_shared"
import { buildOpItemCreateCommand } from "@/components/mdx/_shared/lib/instructionCommands"
import { useTemplateContext } from "@/contexts/useRunbook"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { OnePasswordItemProps } from "./types"

/**
 * Instruction-mode rendering of a OnePasswordItem block: the `op item create`
 * command that saves the same item. Nothing is saved. Built from the raw
 * props, so <Instruction> resolves their templates and asks the reader to
 * paste any sensitive output, which it never shows.
 */
export function OnePasswordItemInstruction({
  id,
  title,
  description,
  vault,
  itemTitle,
  category,
  username,
  password,
  url,
  notes,
  tags,
  fields,
  account,
  inputsId,
  autoCollapse,
}: OnePasswordItemProps) {
  const templateContext = useTemplateContext(inputsId)
  const command = useMemo(
    () =>
      buildOpItemCreateCommand({
        vault,
        title: itemTitle,
        category,
        username,
        password,
        url,
        notes,
        tags,
        fields,
        account,
      }),
    [vault, itemTitle, category, username, password, url, notes, tags, fields, account],
  )

  return (
    <Instruction
      id={id}
      autoCollapse={autoCollapse}
      icon={KeyRound}
      title={
        title ? resolveTemplateReferences(title, templateContext) : "Save this item to 1Password:"
      }
      description={
        description ? resolveTemplateReferences(description, templateContext) : undefined
      }
      command={command}
      templateContext={templateContext}
      note={
        <span>
          Values typed on the command line can show up in your shell history. To keep secrets out of
          it, fill in an item template instead: see{" "}
          <a
            href="https://developer.1password.com/docs/cli/item-create/"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            op item create
          </a>
          .
        </span>
      }
    />
  )
}
