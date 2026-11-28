import { Fragment } from "react"
import { AlertTriangle } from "lucide-react"
import { BlockLink } from "./BlockLink"

interface UnmetSignInWarningProps {
  /** The auth blocks the block's envFrom names that haven't signed in. */
  blockIds: readonly string[]
}

/** Says which auth blocks a block's envFrom is waiting on to sign in. */
export const UnmetSignInWarning: React.FC<UnmetSignInWarningProps> = ({ blockIds }) => {
  if (blockIds.length === 0) return null

  return (
    <div className="mb-3 text-sm text-warning-foreground flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for</strong>{" "}
        {blockIds.map((id, i) => (
          <Fragment key={id}>
            {i > 0 && ", "}
            <BlockLink blockId={id} />
          </Fragment>
        ))}{" "}
        <strong>to sign in.</strong>
        <div className="text-xs mt-1 text-warning-foreground">
          This block runs with their credentials. Sign in with them first.
        </div>
      </div>
    </div>
  )
}
