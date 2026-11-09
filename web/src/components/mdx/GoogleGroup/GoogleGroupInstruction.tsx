import { useMemo } from "react"
import { Users } from "lucide-react"
import { Instruction } from "@/components/mdx/_shared"
import { buildGcloudGroupCommands } from "@/components/mdx/_shared/lib/instructionCommands"
import { useTemplateContext } from "@/contexts/useRunbook"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { GoogleGroupProps } from "./types"

/**
 * Instruction-mode rendering of a GoogleGroup block: the gcloud commands that
 * create the group and add its members. Nothing is created. Built from the raw
 * props, so <Instruction> resolves their templates and asks for any output it
 * can't fill in.
 */
export function GoogleGroupInstruction({
  id,
  title,
  description,
  email,
  displayName,
  groupDescription,
  customerId,
  members,
  role,
  allowExternalSenders,
  inputsId,
  autoCollapse,
}: GoogleGroupProps) {
  const templateContext = useTemplateContext(inputsId)
  const command = useMemo(
    () =>
      buildGcloudGroupCommands({
        email,
        displayName,
        description: groupDescription,
        customerId,
        members,
        role,
      }),
    [email, displayName, groupDescription, customerId, members, role],
  )

  return (
    <Instruction
      id={id}
      autoCollapse={autoCollapse}
      icon={Users}
      title={
        title ? resolveTemplateReferences(title, templateContext) : "Create this Google group:"
      }
      description={
        description ? resolveTemplateReferences(description, templateContext) : undefined
      }
      command={command}
      templateContext={templateContext}
      note={
        allowExternalSenders ? (
          <span>
            Then let anyone email the group: in Google Groups, open the group's settings and set{" "}
            <strong>Who can post</strong> to <strong>Anyone on the web</strong>.
          </span>
        ) : undefined
      }
    />
  )
}
