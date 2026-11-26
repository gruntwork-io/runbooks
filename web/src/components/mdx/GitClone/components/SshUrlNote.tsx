import { Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sshSignInNote } from "../sshUrl"

interface SshUrlNoteProps {
  provider: "github" | "gitlab"
  /** The HTTPS form of the URL; without it the note offers no rewrite. */
  httpsUrl?: string | undefined
  onUseHttps: (url: string) => void
  disabled?: boolean
}

/** Shown under the Git URL field when an SSH URL will not use the linked sign-in. */
export function SshUrlNote({ provider, httpsUrl, onUseHttps, disabled }: SshUrlNoteProps) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Info className="size-3.5 shrink-0" />
      <span>{sshSignInNote(provider)}</span>
      {httpsUrl && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => onUseHttps(httpsUrl)}
          disabled={disabled}
        >
          Use HTTPS URL
        </Button>
      )}
    </div>
  )
}
